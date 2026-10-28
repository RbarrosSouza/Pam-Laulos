import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAuditState, nextAuditOperation, applyAuditResponse, applyAuditFailure, auditPersistenceRow, verifyAuditPersistence } from './n8n-discovery-audit-runtime.mjs';

const repository = resolve(process.env.EXAM_REPO || process.cwd());
const { collectionFixtureDB } = await import(pathToFileURL(join(repository, 'supabase/tests/collection-db.fixture.mjs')));
let db, rpc, role;
before(async () => {
  ({ db, rpc, role } = await collectionFixtureDB());
  await db.exec('RESET ROLE');
  for (const name of ['20261016000006_exam_operational_flow.sql', '20261016000007_exam_clinical_group_eligibility.sql',
    '20261016000008_exam_gmail_origin_identity.sql', '20261016000009_exam_group_after_processing.sql', '20261016000010_exam_group_without_identification.sql']) {
    await db.exec(await fs.readFile(join(repository, 'supabase/migrations', name), 'utf8'));
  }
  for (const name of ['20261027000023_exam_intake_receipts_incidents.sql', '20261027000024_exam_hopelab_notice_snapshots.sql', '20261027000026_exam_intake_source_lookup.sql']) {
    await db.exec(await fs.readFile(join(repository, 'supabase/migrations', name), 'utf8'));
  }
  await role('service_role');
});
after(async () => { await db?.close(); });

async function executeAudit(collectorId, provider) {
  const now = Date.now();
  const cfg = { enabled: true, allowScheduled: false, provider: 'gmail', dataTableId: 'syntheticPrivateTable', collectorId,
    serviceUrl: 'https://fixture.supabase.co/functions/v1/exam-document-service', mailbox: 'audit@example.invalid',
    intakeCutoff: new Date(now - 86400000).toISOString(), maxActions: 200, maxMillis: 180000, gmailMetadataFields: 'id,internalDate,payload',
    monitoring: false, auditLookbackSeconds: 86400, leaseMillis: 900000 };
  let state = loadAuditState([], cfg, 'real-ledger-fixture', now);
  for (let guard = 0; guard < 1000; guard++) {
    const row = auditPersistenceRow(state, cfg);
    state = verifyAuditPersistence([{ collector_key: row.collector_key, state_json: row.state_json, revision: row.revision, id: 1 }], row);
    const context = nextAuditOperation(state, cfg, Date.now());
    if (context.target === 'stop') return { state, result: context.result };
    let body;
    if (context.target !== 'backend') body = await provider(context, now);
    else {
      const p = context.payload;
      if (context.action === 'intake_begin') body = await rpc('begin_exam_intake_sweep', [p.collector_id, p.scope_key, JSON.stringify(p.scope_manifest), p.received_from, p.received_through, p.request_id, p.mode, p.ttl_seconds]);
      else if (context.action === 'intake_event') body = await rpc('record_exam_intake_event', [p.sweep_id, p.run_token, JSON.stringify(p.event)]);
      else if (context.action === 'intake_lookup_source') body = await rpc('lookup_exam_intake_sources', [p.collector_id, JSON.stringify(p.identities)]);
      else body = await rpc('finish_exam_intake_sweep', [p.sweep_id, p.run_token]);
    }
    try { state = applyAuditResponse(context, { statusCode: 200, body }, cfg, Date.now()); }
    catch (error) { state = applyAuditFailure(context, error.message, Date.now()); }
  }
  throw new Error('Fixture did not yield');
}

test('Gmail audit graph commits four per-attachment pending receipts into the real ledger without creating clinical sources or documents', async () => {
  const originalSources = Number((await db.query('SELECT count(*) n FROM exam_document_source')).rows[0].n);
  const originalDocs = Number((await db.query('SELECT count(*) n FROM exam_document')).rows[0].n);
  const audit = await executeAudit('fixture-audit-four', async (context, now) => context.state.phase === 'gmail_list'
    ? { messages: [{ id: 'abcdef01' }] }
    : { id: 'abcdef01', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed',
      parts: Array.from({ length: 4 }, (_, index) => ({ partId: String(index), mimeType: 'application/pdf', filename: 'Sem nome.pdf', body: { attachmentId: 'synthetic-' + index, size: 100 } })) } });
  assert.equal(audit.result.coverageComplete, true);
  assert.equal(audit.result.allPreserved, false);
  assert.equal(audit.result.scanFinished, false);
  assert.equal(audit.result.checkpointAdvanced, false);
  assert.equal(audit.result.counts.pending, 4);
  assert.equal(audit.result.counts.missing_receipts, 0);
  assert.equal(audit.result.monitoring, false);
  assert.equal((await db.query("SELECT monitored FROM exam_intake_health WHERE collector_id='fixture-audit-four'")).rows[0].monitored, false);
  assert.equal(Number((await db.query('SELECT count(*) n FROM exam_document_source')).rows[0].n), originalSources);
  assert.equal(Number((await db.query('SELECT count(*) n FROM exam_document')).rows[0].n), originalDocs);
  const receipts = await db.query("SELECT disposition,source_id,document_id FROM exam_intake_receipt WHERE collector_id='fixture-audit-four'");
  assert.equal(receipts.rows.length, 4);
  assert(receipts.rows.every(row => row.disposition === 'pending' && row.source_id === null && row.document_id === null));
});

test('a later empty audit inventory finishes its explicit window while leaving prior pending receipts and incidents intact', async () => {
  const audit = await executeAudit('fixture-audit-empty', async () => ({ messages: [] }));
  assert.equal(audit.result.coverageComplete, true);
  assert.equal(audit.result.scanFinished, true);
  assert.equal(audit.result.checkpointAdvanced, false);
  assert.equal(audit.result.counts.messages, 0);
  assert.equal(audit.result.counts.pages, 1);
  assert.equal(Number((await db.query("SELECT count(*) n FROM exam_intake_receipt WHERE collector_id='fixture-audit-four' AND disposition='pending'")).rows[0].n), 4);
});

test('real read-only lookup proves an existing canonical source and the audit writes only its saved ledger receipt', async () => {
  const receivedAt = new Date(Date.now() - 60000).toISOString();
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='audit-fixture-group'");
  const reserved = await rpc('reserve_exam_document_source', [JSON.stringify({ channel: 'email', account_id: 'gmail:audit@example.invalid', message_id: 'abcdef11',
    attachment_id: 'gmail-part:["0","synthetic-0"]', original_name: 'Fixture.pdf', mime_type: 'application/pdf', received_at: receivedAt,
    metadata: { provider: 'gmail', mailbox: 'audit@example.invalid', gmail_message_id: 'abcdef11', gmail_part_id: '0', gmail_attachment_id: 'synthetic-0' } })]);
  const file = { sha256: 'e'.repeat(64), size_bytes: 100, drive_file_id: 'fixture-private-file', drive_folder_id: 'fixture-private-folder' };
  const staged = await rpc('stage_exam_document_file', [reserved.document_id, JSON.stringify(file), 'fixture-audit-saved']);
  if (staged.claimed) await rpc('confirm_exam_document_file', [staged.document_id, JSON.stringify({ ...file, drive_file_id: staged.drive_file_id }), staged.lease_token]);
  const clinicalSnapshot = async () => {
    const result = {};
    for (const table of ['exam_document', 'exam_document_source', 'exam_document_delivery', 'exam_document_event']) result[table] =
      (await db.query('SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) hash FROM ' + table + ' t')).rows[0].hash;
    return result;
  };
  const before = await clinicalSnapshot();
  const audit = await executeAudit('fixture-audit-saved', async (context, now) => context.state.phase === 'gmail_list'
    ? { messages: [{ id: 'abcdef11' }] } : { id: 'abcdef11', internalDate: String(now - 60000), payload: { partId: '', mimeType: 'multipart/mixed',
      parts: [{ partId: '0', mimeType: 'application/pdf', filename: 'Sem nome.pdf', body: { attachmentId: 'synthetic-0', size: 100 } }] } });
  assert.equal(audit.result.coverageComplete, true); assert.equal(audit.result.allPreserved, true); assert.equal(audit.result.scanFinished, true);
  assert.equal(audit.result.counts.saved, 1); assert.equal(audit.result.counts.pending, 0); assert.equal(audit.result.checkpointAdvanced, false);
  const receipt = (await db.query("SELECT disposition,source_id,document_id FROM exam_intake_receipt WHERE collector_id='fixture-audit-saved'")).rows[0];
  assert.equal(receipt.disposition, 'saved'); assert.equal(receipt.document_id, staged.document_id);
  assert.deepEqual(await clinicalSnapshot(), before);
});
