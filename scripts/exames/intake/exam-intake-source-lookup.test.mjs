import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const repository = resolve(process.env.EXAM_REPO || process.cwd());
const { collectionFixtureDB } = await import(pathToFileURL(join(repository, 'supabase/tests/collection-db.fixture.mjs')));
const ts = createRequire(join(repository,'package.json'))('typescript');
const routeSource=await readFile(join(repository,'supabase/functions/exam-document-service/intake-service-routes.ts'),'utf8');
const routeExports={};
vm.runInNewContext(ts.transpileModule(routeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:routeExports,TextEncoder});
let db, rpc, role, first, alias, pending, legacy, v2;
const account = 'gmail:lookup@example.invalid', relation = 'a'.repeat(64);
const identity = (message_id, attachment_id = 'pdf', account_id = account) => ({ account_id, message_id, attachment_id, partition_key: 'mailbox' });
const lookup = identities => rpc('lookup_exam_intake_sources', ['lookup-fixture', JSON.stringify(identities)]);
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
async function preserve(messageId, hash, extra = {}) {
  const source = { channel: 'email', account_id: account, message_id: messageId, attachment_id: 'pdf', original_name: 'Patient name must never leak.pdf',
    received_at: new Date(Date.now() - 60000).toISOString(), metadata: {}, ...extra };
  const reserved = await rpc(extra.metadata?.hopelab_notice_protocol ? 'reserve_exam_intake_source' : 'reserve_exam_document_source', [JSON.stringify(source)]);
  const file = { sha256: hash, size_bytes: 100, drive_file_id: 'private-file-' + reserved.document_id, drive_folder_id: 'private-folder' };
  const staged = await rpc(extra.metadata?.hopelab_notice_protocol ? 'stage_exam_intake_file' : 'stage_exam_document_file', [reserved.document_id, JSON.stringify(file), 'lookup-fixture']);
  if (staged.claimed) await rpc('confirm_exam_document_file', [staged.document_id, JSON.stringify({ ...file, drive_file_id: staged.drive_file_id }), staged.lease_token]);
  return { source: await one('SELECT * FROM exam_document_source WHERE account_id=$1 AND message_id=$2 AND attachment_id=$3', [account, messageId, source.attachment_id]), documentId: staged.document_id };
}
before(async () => {
  ({ db, rpc, role } = await collectionFixtureDB());
  await db.exec('RESET ROLE');
  for (const name of ['20261016000006_exam_operational_flow.sql', '20261016000007_exam_clinical_group_eligibility.sql',
    '20261016000008_exam_gmail_origin_identity.sql', '20261016000009_exam_group_after_processing.sql', '20261016000010_exam_group_without_identification.sql']) {
    await db.exec(await readFile(join(repository, 'supabase/migrations', name), 'utf8'));
  }
  for (const name of ['20261027000023_exam_intake_receipts_incidents.sql', '20261027000024_exam_hopelab_notice_snapshots.sql', '20261027000026_exam_intake_source_lookup.sql']) {
    await db.exec(await readFile(join(repository,'supabase/migrations',name), 'utf8'));
  }
  await role('service_role');
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='lookup-group'");
  await rpc('begin_exam_intake_sweep', ['lookup-fixture', 'b'.repeat(64), JSON.stringify({ provider: 'gmail', account_id: account, scope_kind: 'mailbox', policy_version: 'intake_v2', sender_policy: 'all' }),
    new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 1000).toISOString(), crypto.randomUUID(), 'audit', 900]);
  first = await preserve('abcdef01', 'c'.repeat(64));
  pending = await rpc('reserve_exam_document_source', [JSON.stringify({ channel: 'email', account_id: account, message_id: 'abcdef02', attachment_id: 'pdf', original_name: 'Pending patient.pdf', received_at: new Date().toISOString() })]);
  alias = await preserve('abcdef03', 'c'.repeat(64));
  legacy = await preserve('hopelab-result:' + relation, 'd'.repeat(64), { attachment_id: 'hopelab-link:' + relation,
    metadata: { provider: 'hopelab_link', gmail_message_id: 'abcdef10', link_sha256: relation } });
  v2 = await preserve('abcdef12', 'd'.repeat(64), { attachment_id: 'hopelab-link:' + relation,
    metadata: { provider: 'hopelab_link', gmail_message_id: 'abcdef12', link_sha256: relation, hopelab_notice_protocol: 'gmail_notice_link_v2' } });
});
after(async () => { await db?.close(); });

test('lookup is service-only and has a stable read-only function contract', async () => {
  for (const name of ['anon', 'authenticated']) {
    await role(name);
    await assert.rejects(lookup([identity('abcdef01')]), error => error.code === '42501');
  }
  await role('service_role');
  const meta = await one("SELECT p.provolatile,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') member,has_function_privilege('service_role',p.oid,'EXECUTE') worker FROM pg_proc p WHERE p.oid='public.lookup_exam_intake_sources(text,jsonb)'::regprocedure");
  assert.equal(meta.provolatile, 's'); assert.equal(meta.prosecdef, true); assert.equal(meta.anon, false); assert.equal(meta.member, false); assert.equal(meta.worker, true);
});

test('exact source, account, attachment and canonical bytes produce saved while unknown or incomplete sources stay explicit', async () => {
  const result = await lookup([identity('abcdef01'), identity('abcdef02'), identity('abcdef99'), identity('abcdef01', 'wrong-attachment'), identity('abcdef01', 'pdf', 'gmail:other@example.invalid')]);
  assert.equal(result.contract, 'exam_intake_source_lookup_v1'); assert.equal(result.items.length, 5);
  assert.equal(result.items[0].status, 'saved'); assert.equal(result.items[0].source_id, first.source.id); assert.equal(result.items[0].document_id, first.documentId);
  assert.equal(result.items[0].sha256, 'c'.repeat(64)); assert.equal(result.items[0].size_bytes, 100);
  assert.equal(result.items[1].status, 'pending'); assert.equal(result.items[1].file_status, 'pending');
  assert.equal(result.items[2].status, 'not_found'); assert.equal(result.items[3].status, 'not_found');
  assert.equal(result.items[4].status, 'pending'); assert.equal(result.items[4].reason, 'lookup_account_scope_mismatch'); assert.equal(result.items[4].source_id, null);
  for (const forbidden of ['Patient name', 'private-folder', 'private-file-', 'original_name', 'extracted_data', 'confirmed_data', 'drive_file_id', 'lease_token']) assert(!JSON.stringify(result).includes(forbidden));
});

test('cross-channel content dedupe retains independent source proof and reports group status without reserving delivery', async () => {
  assert.equal(alias.documentId, first.documentId); assert.notEqual(alias.source.id, first.source.id);
  await db.query("INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,external_id,external_status) VALUES($1,'group','lookup-secondary','sent','receipt-one','delivered') ON CONFLICT DO NOTHING", [first.documentId]);
  const result = await lookup([identity('abcdef03')]);
  assert.equal(result.items[0].status, 'saved'); assert.equal(result.items[0].document_id, first.documentId); assert.equal(result.items[0].group_status, 'sent');
});

test('legacy link source can prove only its recorded first notice metadata and never a later notice using the same URL', async () => {
  const result = await lookup([identity('abcdef10', 'hopelab-link:' + relation), identity('abcdef11', 'hopelab-link:' + relation), identity('abcdef12', 'hopelab-link:' + relation)]);
  assert.equal(result.items[0].status, 'pending'); assert.equal(result.items[0].match_kind, 'legacy_notice_metadata');
  assert.equal(result.items[0].reason, 'legacy_notice_binding_requires_review'); assert.equal(result.items[0].canonical_file_preserved, true);
  assert.equal(result.items[0].source_id, legacy.source.id);
  assert.equal(result.items[1].status, 'not_found'); assert.equal(result.items[1].source_id, null); assert.equal(result.items[1].document_id, null);
  assert.equal(result.items[2].status, 'saved'); assert.equal(result.items[2].source_id, v2.source.id);
});

test('lookup works inside a read-only transaction and does not mutate files, delivery attempts, receipts, incidents or events', async () => {
  const snapshot = async () => {
    const result = {};
    for (const table of ['exam_document', 'exam_document_source', 'exam_document_delivery', 'exam_document_event', 'exam_intake_receipt', 'exam_intake_incident', 'exam_intake_alert_outbox']) {
      result[table] = (await db.query('SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) hash FROM ' + table + ' t')).rows[0].hash;
    }
    return result;
  };
  const before = await snapshot();
  await db.exec('BEGIN; SET TRANSACTION READ ONLY;');
  await lookup([identity('abcdef01'), identity('abcdef99')]);
  await db.exec('ROLLBACK;');
  assert.deepEqual(await snapshot(), before);
});

test('batch limits and strict identity schema prevent broad searches and extra private fields', async () => {
  await assert.rejects(lookup([]), /one to one hundred/);
  await assert.rejects(lookup(Array(101).fill(identity('abcdef01'))), /one to one hundred/);
  await assert.rejects(lookup([{ ...identity('abcdef01'), patient_name: 'forbidden' }]), /Only sanitized/);
  await assert.rejects(rpc('lookup_exam_intake_sources', ['missing-collector', JSON.stringify([identity('abcdef01')])]), /Registered intake account/);
});

test('a source still pointing to an alias stays pending even when its canonical bytes are already preserved', async () => {
  const reserved = await rpc('reserve_exam_document_source', [JSON.stringify({ channel: 'email', account_id: account, message_id: 'abcdef20', attachment_id: 'pdf', original_name: 'Alias fixture.pdf', received_at: new Date().toISOString() })]);
  await db.query('UPDATE exam_document SET canonical_document_id=$2 WHERE id=$1', [reserved.document_id, first.documentId]);
  const result = (await lookup([identity('abcdef20')])).items[0];
  assert.equal(result.status, 'pending'); assert.equal(result.reason, 'source_alias_binding_requires_review');
  assert.equal(result.document_id, first.documentId); assert.equal(result.source_document_id, reserved.document_id);
  assert.equal(result.canonical_file_preserved, true);
});

test('canonical cycles are bounded and reported as pending rather than creating or repairing document bindings', async () => {
  const created = [];
  for (const message_id of ['abcdef21', 'abcdef22']) created.push(await rpc('reserve_exam_document_source', [JSON.stringify({ channel: 'email', account_id: account, message_id, attachment_id: 'pdf', original_name: 'Cycle fixture.pdf', received_at: new Date().toISOString() })]));
  await db.query('UPDATE exam_document SET canonical_document_id=$2 WHERE id=$1', [created[0].document_id, created[1].document_id]);
  await db.query('UPDATE exam_document SET canonical_document_id=$2 WHERE id=$1', [created[1].document_id, created[0].document_id]);
  const result = (await lookup([identity('abcdef21')])).items[0];
  assert.equal(result.status, 'pending'); assert.equal(result.reason, 'canonical_lineage_unresolved'); assert.equal(result.document_id, null);
});

test('the actual Edge action adapter invokes the real lookup RPC inside a read-only transaction', async () => {
  await role('service_role');
  assert.equal(routeExports.intakeActions.has('intake_lookup_source'),true);
  const calls=[];
  const rpcAdapter=async(name,args)=>{
    calls.push({name,args});assert.equal(name,'lookup_exam_intake_sources');
    return rpc(name,[args.p_collector_id,JSON.stringify(args.p_identities)]);
  };
  const identities=[identity('abcdef01'),identity('abcdef02'),identity('abcdef99')];
  let result;
  await db.exec('BEGIN; SET TRANSACTION READ ONLY;');
  try {
    result=await routeExports.runIntakeAction('intake_lookup_source',{collector_id:'lookup-fixture',identities},rpcAdapter,{uuid(){throw new Error('lookup must not allocate identifiers');},hash(){throw new Error('lookup must not read original bytes');}});
  } finally { await db.exec('ROLLBACK;'); }
  assert.equal(calls.length,1);assert.equal(result.contract,'exam_intake_source_lookup_v1');
  assert.deepEqual(result.items.map(item=>item.status),['saved','pending','not_found']);
  assert.equal(result.items[0].source_id,first.source.id);assert.equal(result.items[0].document_id,first.documentId);
  await assert.rejects(routeExports.runIntakeAction('intake_lookup_source',{collector_id:'lookup-fixture',identities:[]},rpcAdapter,{}),/INTAKE_LOOKUP_IDENTITIES_INVALID/);
  assert.equal(calls.length,1);
});
