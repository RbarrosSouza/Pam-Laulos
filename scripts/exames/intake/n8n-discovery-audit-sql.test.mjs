import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadAuditState, nextAuditOperation, applyAuditResponse, applyAuditFailure, auditPersistenceRow, verifyAuditPersistence } from './n8n-discovery-audit-runtime.mjs';

const repository = resolve(process.env.EXAM_REPO || process.cwd());
const { collectionFixtureDB } = await import(pathToFileURL(join(repository, 'supabase/tests/collection-db.fixture.mjs')));
const ts = createRequire(join(repository, 'package.json'))('typescript'), routes = {};
vm.runInNewContext(ts.transpileModule(await fs.readFile(join(repository, 'supabase/functions/exam-document-service/intake-service-routes.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: routes, TextEncoder });
let db, rpc, role;
before(async () => {
  ({ db, rpc, role } = await collectionFixtureDB());
  await db.exec('RESET ROLE');
  for (const name of ['20261016000006_exam_operational_flow.sql', '20261016000007_exam_clinical_group_eligibility.sql',
    '20261016000008_exam_gmail_origin_identity.sql', '20261016000009_exam_group_after_processing.sql', '20261016000010_exam_group_without_identification.sql']) {
    await db.exec(await fs.readFile(join(repository, 'supabase/migrations', name), 'utf8'));
  }
  for (const name of ['20261027000023_exam_intake_receipts_incidents.sql', '20261027000024_exam_hopelab_notice_snapshots.sql', '20261027000026_exam_intake_source_lookup.sql', '20261028000030_exam_intake_pending_reconciliation.sql', '20261028000036_exam_intake_gmail_part_identity.sql']) {
    await db.exec(await fs.readFile(join(repository, 'supabase/migrations', name), 'utf8'));
  }
  const normalization=await fs.readFile(join(repository,'supabase/migrations/20261019000016_exam_hemogram_normalization.sql'),'utf8');
  await db.exec(normalization.slice(normalization.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),normalization.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
  for(const name of ['20261028000031_exam_intake_exam_failures.sql','20261028000035_exam_attention_scope_update.sql','20261028000037_exam_attention_unreadable_files.sql','20261028000038_exam_intake_receipt_details.sql'])
    await db.exec(await fs.readFile(join(repository,'supabase/migrations',name),'utf8'));
  await role('service_role');
});
after(async () => { await db?.close(); });

async function executeAudit(collectorId, provider, options = {}) {
  const now = Date.now();
  const cfg = { enabled: true, allowScheduled: false, provider: 'gmail', dataTableId: 'syntheticPrivateTable', collectorId,
    serviceUrl: 'https://fixture.supabase.co/functions/v1/exam-document-service', mailbox: 'audit@example.invalid',
    intakeCutoff: new Date(now - 86400000).toISOString(), maxActions: 200, maxMillis: 180000, gmailMetadataFields: 'id,internalDate,payload',
    monitoring: false, auditLookbackSeconds: 86400, leaseMillis: 900000, ...options.config };
  let state = loadAuditState(options.row ? [options.row] : [], cfg, 'real-ledger-fixture', now);
  for (let guard = 0; guard < 1000; guard++) {
    const row = auditPersistenceRow(state, cfg);
    state = verifyAuditPersistence([{ collector_key: row.collector_key, state_json: row.state_json, revision: row.revision, id: 1 }], row);
    const context = nextAuditOperation(state, cfg, Date.now());
    if (context.target === 'stop') {
      state={...context.state,releaseLease:true,finalResult:context.result};
      const released=auditPersistenceRow(state,cfg);
      state=verifyAuditPersistence([{collector_key:released.collector_key,state_json:released.state_json,revision:released.revision,id:1}],released);
      return { state, result: context.result, cfg, row:{id:1,collector_key:released.collector_key,state_json:released.state_json,revision:released.revision} };
    }
    let body;
    if (context.target !== 'backend') body = await provider(context, now);
    else {
      const p = context.payload;
      if (context.action === 'intake_begin') body = await rpc('begin_exam_intake_sweep', [p.collector_id, p.scope_key, JSON.stringify(p.scope_manifest), p.received_from, p.received_through, p.request_id, p.mode, p.ttl_seconds]);
      else if (context.action === 'intake_event') body = await rpc('record_exam_intake_event', [p.sweep_id, p.run_token, JSON.stringify(p.event)]);
      else if (['intake_lookup_source','intake_list_pending_sources','intake_resolve_receipt_saved'].includes(context.action))
        body = await routes.runIntakeAction(context.action, p, (name,args)=>rpc(name,Object.values(args).map(value=>value && typeof value==='object'?JSON.stringify(value):value)),
          {uuid(value){if(typeof value!=='string'||!/^[a-f\d-]{36}$/i.test(value)) throw new Error('INVALID_UUID');return value;},hash(){throw new Error('Unexpected hash');}});
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

test('recheck resolves a previously pending receipt against real canonical saved proof without changing clinical records', async () => {
  const config = { continuous: true, allowScheduled: true, overlapSeconds: 300, maxRepeatedFailures: 3, notificationMode: 'home_only', recheckPending: true };
  const first = await executeAudit('fixture-recheck-saved', async (context, now) => context.state.phase === 'gmail_list'
    ? { messages: [{ id: 'abcdef51' }] } : { id: 'abcdef51', internalDate: String(now - 60000), payload: {
      partId: '0', mimeType: 'application/pdf', filename: '', body: { attachmentId: 'fixture-recheck', size: 100 } } }, { config });
  assert.equal(first.result.counts.pending, 1);
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='audit-fixture-group'");
  const receivedAt = new Date(Date.now() - 60000).toISOString();
  const reserved = await rpc('reserve_exam_document_source', [JSON.stringify({ channel: 'email', account_id: 'gmail:audit@example.invalid', message_id: 'abcdef51',
    attachment_id: 'gmail-part:["0","fixture-recheck"]', original_name: 'original.pdf', mime_type: 'application/pdf', received_at: receivedAt,
    metadata: { provider: 'gmail', mailbox: 'audit@example.invalid', gmail_message_id: 'abcdef51', gmail_part_id: '0', gmail_attachment_id: 'fixture-recheck' } })]);
  const file = { sha256: 'f'.repeat(64), size_bytes: 100, drive_file_id: 'fixture-recheck-file', drive_folder_id: 'fixture-private-folder' };
  const staged = await rpc('stage_exam_document_file', [reserved.document_id, JSON.stringify(file), 'fixture-recheck']);
  await rpc('confirm_exam_document_file', [staged.document_id, JSON.stringify({ ...file, drive_file_id: staged.drive_file_id }), staged.lease_token]);
  const snapshot = async () => Object.fromEntries(await Promise.all(['exam_document','exam_document_source','exam_document_delivery','exam_document_event'].map(async table =>
    [table, (await db.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) hash FROM " + table + ' t')).rows[0].hash])));
  const before = await snapshot();
  const next = await executeAudit('fixture-recheck-saved', async () => ({ messages: [],resultSizeEstimate: 0 }), { config: first.cfg, row: first.row });
  const receipt = (await db.query("SELECT disposition,document_id,sha256 FROM exam_intake_receipt WHERE collector_id='fixture-recheck-saved'")).rows[0];
  assert.equal(receipt.disposition, 'saved'); assert.equal(receipt.document_id, staged.document_id); assert.equal(receipt.sha256, file.sha256);
  assert.equal(next.result.coverageComplete, true); assert.deepEqual(await snapshot(), before);
});

test('a pending receipt reconciles a changed Gmail attachment locator only through the same unique message and MIME part', async()=>{
  const config={continuous:true,allowScheduled:true,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',recheckPending:true};
  const first=await executeAudit('fixture-part-recheck',async(context,now)=>context.state.phase==='gmail_list'?{messages:[{id:'abcdef61'}]}:
    {id:'abcdef61',internalDate:String(now-60000),payload:{partId:'1',mimeType:'application/pdf',filename:'',body:{attachmentId:'old-locator',size:100}}},{config});
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='audit-fixture-group'");
  const reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'gmail:audit@example.invalid',message_id:'abcdef61',attachment_id:'gmail-part:["1","new-locator"]',
    original_name:'original.pdf',mime_type:'application/pdf',received_at:new Date(Date.now()-60000).toISOString(),metadata:{provider:'gmail',mailbox:'audit@example.invalid',gmail_message_id:'abcdef61',gmail_part_id:'1',gmail_attachment_id:'new-locator'}})]);
  const file={sha256:'8'.repeat(64),size_bytes:100,drive_file_id:'fixture-part-file',drive_folder_id:'fixture-private-folder'};
  const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'fixture-part-recheck']);
  await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
  const before=(await db.query('SELECT attachment_id FROM exam_document_source WHERE document_id=$1',[staged.document_id])).rows[0].attachment_id;
  const lookup=await rpc('lookup_exam_intake_sources',['fixture-part-recheck',JSON.stringify([{account_id:'gmail:audit@example.invalid',partition_key:'mailbox',message_id:'abcdef61',attachment_id:'gmail-part:["1","old-locator"]'}])]);
  assert.equal(lookup.items[0].match_kind,'gmail_part_origin');assert.equal(lookup.items[0].status,'saved');
  await executeAudit('fixture-part-recheck',async()=>({messages:[],resultSizeEstimate:0}),{config:first.cfg,row:first.row});
  const receipt=(await db.query("SELECT disposition,document_id FROM exam_intake_receipt WHERE collector_id='fixture-part-recheck'")).rows[0];
  assert.equal(receipt.disposition,'saved');assert.equal(receipt.document_id,staged.document_id);
  assert.equal((await db.query('SELECT attachment_id FROM exam_document_source WHERE document_id=$1',[staged.document_id])).rows[0].attachment_id,before);
});

test('Gmail locator fallback fails closed on wrong account, wrong part, corrupted metadata and ambiguous sources',async()=>{
  const identity={account_id:'gmail:audit@example.invalid',partition_key:'mailbox',message_id:'abcdef61',attachment_id:'gmail-part:["1","another-locator"]'};
  const lookup=async x=>(await rpc('lookup_exam_intake_sources',['fixture-part-recheck',JSON.stringify([x])])).items[0];
  assert.equal((await lookup({...identity,account_id:'gmail:other@example.invalid'})).reason,'lookup_account_scope_mismatch');
  assert.equal((await lookup({...identity,message_id:'abcdef62'})).status,'not_found');
  assert.equal((await lookup({...identity,attachment_id:'gmail-part:["2","another-locator"]'})).status,'not_found');
  for(const invalid of ['gmail-part:{}','gmail-part:garbage','gmail-part:[1,"x"]','gmail-part:["1",{}]','gmail-part:["1"]'])
    assert.equal((await lookup({...identity,attachment_id:invalid})).status,'not_found');
  const source=(await db.query("SELECT * FROM exam_document_source WHERE message_id='abcdef61'")).rows[0];
  const receipt=(await db.query("SELECT id FROM exam_intake_receipt WHERE collector_id='fixture-part-recheck'")).rows[0];
  await db.exec('BEGIN');
  try {
    await db.query("UPDATE exam_document_source SET metadata=jsonb_set(metadata,'{gmail_attachment_id}',to_jsonb('incorrect'::text)) WHERE id=$1",[source.id]);
    const corrupt=await lookup(identity);assert.equal(corrupt.status,'pending');assert.equal(corrupt.reason,'gmail_part_binding_requires_review');
    await assert.rejects(rpc('resolve_exam_intake_receipt_saved',[receipt.id,source.id,source.document_id]),/not proven/);
  } finally { await db.exec('ROLLBACK'); }
  await db.exec('BEGIN');
  try {
    await db.query("INSERT INTO exam_document_source(document_id,channel,account_id,message_id,attachment_id,received_at,metadata) SELECT document_id,channel,account_id,message_id,'gmail-part:[\"1\",\"duplicate\"]',received_at,jsonb_set(metadata,'{gmail_attachment_id}',to_jsonb('duplicate'::text)) FROM exam_document_source WHERE id=$1",[source.id]);
    const ambiguous=await lookup(identity);assert.equal(ambiguous.status,'pending');assert.equal(ambiguous.reason,'gmail_part_binding_requires_review');
    await assert.rejects(rpc('resolve_exam_intake_receipt_saved',[receipt.id,source.id,source.document_id]),/not proven/);
  } finally { await db.exec('ROLLBACK'); }
  for(const denied of ['anon','authenticated']){await role(denied);await assert.rejects(db.query("SELECT public.exam_intake_gmail_part_key('gmail-part:[\"1\",null]')"),error=>error.code==='42501');}
  await role('service_role');
});

test('recheck-only canary proves changed locator without calling or sending through child',async()=>{
  const cutoff=new Date(Date.now()-3600000).toISOString();let calls=0;
  const audit=await executeAudit('fixture-recheck-only',async(context,now)=>{
    if(context.target==='bridge'){calls++;throw new Error('Recheck-only must not call child');}
    return context.state.phase==='gmail_list'?{messages:[{id:'abcdef61'}]}:{id:'abcdef61',internalDate:String(now-60000),payload:{partId:'1',mimeType:'application/pdf',filename:'',body:{attachmentId:'third-locator',size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:false,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow',canary:true,canaryMessageId:'abcdef61',canaryRecheckOnly:true}});
  assert.equal(calls,0);assert.equal(audit.result.coverageComplete,true);
  assert.equal((await db.query("SELECT disposition FROM exam_intake_receipt WHERE collector_id='fixture-recheck-only'")).rows[0].disposition,'saved');
});

test('recheck-only canary pauses with a pending receipt when the selected source is not saved',async()=>{
  const cutoff=new Date(Date.now()-3600000).toISOString();let calls=0;
  const audit=await executeAudit('fixture-recheck-unproven',async(context,now)=>{
    if(context.target==='bridge'){calls++;throw new Error('Recheck-only must not call child');}
    return context.state.phase==='gmail_list'?{messages:[{id:'abcdef63'}]}:{id:'abcdef63',internalDate:String(now-60000),payload:{partId:'1',mimeType:'application/pdf',body:{attachmentId:'no-source',size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:false,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow',canary:true,canaryMessageId:'abcdef63',canaryRecheckOnly:true}});
  assert.equal(calls,0);assert.equal(audit.state.canaryPaused,true);assert.equal(audit.result.lastError.code,'audit_recheck_saved_unproven');
  assert.equal((await db.query("SELECT disposition FROM exam_intake_receipt WHERE collector_id='fixture-recheck-unproven'")).rows[0].disposition,'pending');
});

test('a later empty audit inventory finishes its explicit window while leaving prior pending receipts and incidents intact', async () => {
  const audit = await executeAudit('fixture-audit-empty', async () => ({ messages: [],resultSizeEstimate: 0 }));
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

test('continuous audit starts a new proved window despite old pending receipts and preserves their unique identity in the real ledger', async () => {
  const metadata = (id, now) => ({ id, internalDate: String(now - 60000), payload: { partId: '0', mimeType: 'application/pdf', body: { attachmentId: 'fixture-locator', size: 100 } } });
  const first = await executeAudit('fixture-continuous-pending', async (context, now) => context.state.phase === 'gmail_list'
    ? { messages: [{ id: 'abcdef31' }] } : metadata('abcdef31', now),
  { config: { continuous: true, allowScheduled: true, overlapSeconds: 300, maxRepeatedFailures: 3, notificationMode: 'home_only' } });
  assert.equal(first.result.coverageComplete, true); assert.equal(first.result.scanFinished, false); assert.equal(first.result.counts.pending, 1);
  const next = await executeAudit('fixture-continuous-pending', async (context, now) => context.state.phase === 'gmail_list'
    ? { messages: [{ id: 'abcdef31' }, { id: 'abcdef32' }] } : metadata(context.state.messageQueue[context.state.messageIndex].id, now),
  { config: first.cfg, row: first.row });
  assert.notEqual(next.state.sweepId, first.state.sweepId);
  assert.equal(next.state.receivedFrom, new Date(Date.parse(first.state.receivedThrough) - 300000).toISOString());
  assert.equal(next.result.coverageComplete, true); assert.equal(next.result.allPreserved, false); assert.equal(next.result.counts.messages, 2);
  assert.equal(next.result.counts.pending, 2); assert.equal(next.result.checkpointAdvanced, false); assert.equal(next.result.monitoring, false);
  assert.equal(Number((await db.query("SELECT count(*) n FROM exam_intake_receipt WHERE collector_id='fixture-continuous-pending'")).rows[0].n), 2);
  assert.equal((await db.query("SELECT monitored FROM exam_intake_health WHERE collector_id='fixture-continuous-pending'")).rows[0].monitored, false);
});

test('prospective bridge starts only after a pending receipt is durable and requires an independent saved lookup', async () => {
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='audit-fixture-group'");
  const cutoff=new Date(Date.now()-3600000).toISOString();let calls=0;
  const audit=await executeAudit('fixture-bridge-prospective',async(context,now)=>{
    if(context.target==='bridge') {
      calls++;const receipt=(await db.query("SELECT disposition FROM exam_intake_receipt WHERE collector_id='fixture-bridge-prospective' AND message_id='abcdef71'")).rows[0];
      assert.equal(receipt?.disposition,'pending');assert.equal(context.payload.cutoff,cutoff);assert.equal(context.payload.message_id,'abcdef71');
      const reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'gmail:audit@example.invalid',message_id:'abcdef71',
        attachment_id:'gmail-part:["0","changed-locator"]',original_name:'original.pdf',mime_type:'application/pdf',received_at:new Date(now-60000).toISOString(),
        metadata:{provider:'gmail',mailbox:'audit@example.invalid',gmail_message_id:'abcdef71',gmail_part_id:'0',gmail_attachment_id:'changed-locator'}})]);
      const file={sha256:'9'.repeat(64),size_bytes:100,drive_file_id:'fixture-bridge-file',drive_folder_id:'fixture-private-folder'};
      const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'fixture-bridge']);
      await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
      return {completed:true};
    }
    return context.state.phase==='gmail_list'?{messages:[{id:'abcdef71'}]}:{id:'abcdef71',internalDate:String(now-60000),payload:{partId:'0',mimeType:'application/pdf',filename:'',body:{attachmentId:'fixture-bridge',size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:true,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow'}});
  assert.equal(calls,1);assert.equal(audit.result.coverageComplete,true);
  const receipt=(await db.query("SELECT disposition,sha256 FROM exam_intake_receipt WHERE collector_id='fixture-bridge-prospective'")).rows[0];
  assert.equal(receipt.disposition,'saved');assert.equal(receipt.sha256,'9'.repeat(64));
});

test('an uncertain bridge result remains pending while later messages continue, even if a child claims success', async () => {
  const cutoff=new Date(Date.now()-3600000).toISOString(),calls=[];
  const audit=await executeAudit('fixture-bridge-uncertain',async(context,now)=>{
    if(context.target==='bridge'){calls.push(context.payload.message_id);return {completed:context.payload.message_id!=='abcdef81'};}
    if(context.state.phase==='gmail_list')return {messages:[{id:'abcdef81'},{id:'abcdef82'}]};
    return {id:context.state.messageQueue[context.state.messageIndex].id,internalDate:String(now-60000),payload:{partId:'0',mimeType:'application/pdf',filename:'',body:{attachmentId:'fixture-'+context.state.messageIndex,size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:true,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow'}});
  assert.deepEqual(calls,['abcdef81','abcdef82']);assert.equal(audit.result.coverageComplete,true);assert.equal(audit.result.allPreserved,false);
  assert.equal(audit.result.lastError.code,'audit_bridge_response_uncertain');
  assert.equal(Number((await db.query("SELECT count(*) n FROM exam_intake_receipt WHERE collector_id='fixture-bridge-uncertain' AND disposition='pending'")).rows[0].n),2);
});

test('three persistent provider failures close a real SQL sweep, retain its gap, and permit a newer window',async()=>{
  const cutoff=new Date(Date.now()-49*3600000).toISOString(),config={intakeCutoff:cutoff,continuous:true,allowScheduled:true,
    overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',prospective:true};
  const broken=async()=>({messages:[null]});let result=await executeAudit('fixture-gap-forward',broken,{config});const initialFrom=result.state.receivedFrom,initialThrough=result.state.receivedThrough;
  assert.equal(result.result.coverageComplete,false);assert.equal(result.state.failureStreak.count,1);
  for(let n=0;n<2;n++)result=await executeAudit('fixture-gap-forward',broken,{config:result.cfg,row:result.row});
  assert.equal(result.state.failureStreak.count,3,JSON.stringify({phase:result.state.phase,halt:result.state.halt,lastError:result.state.lastError}));
  const closed=await executeAudit('fixture-gap-forward',broken,{config:result.cfg,row:result.row});
  assert.equal(closed.state.phase,'done');assert.equal(closed.result.coverageComplete,false);
  const next=await executeAudit('fixture-gap-forward',async()=>({messages:[],resultSizeEstimate:0}),{config:closed.cfg,row:closed.row});
  assert.equal(next.state.windowKind,'current');assert.equal(next.state.coverageGaps.length,1);
  assert.equal(next.state.coverageGaps[0].from,initialFrom);assert.equal(next.state.coverageGaps[0].through,initialThrough);
  assert(Date.parse(next.state.receivedThrough)>Date.parse(initialThrough));assert.equal(next.result.coverageComplete,true);
  assert.equal(next.state.coverageProof,null);
});

test('manual canary dispatches only its selected fixture and pauses when saved proof is absent',async()=>{
  const cutoff=new Date(Date.now()-3600000).toISOString(),calls=[];
  const audit=await executeAudit('fixture-bridge-canary',async(context,now)=>{
    if(context.target==='bridge'){calls.push(context.payload.message_id);return {completed:true};}
    if(context.state.phase==='gmail_list')return {messages:[{id:'abcdef91'},{id:'abcdef92'}]};
    return {id:context.state.messageQueue[context.state.messageIndex].id,internalDate:String(now-60000),payload:{partId:'0',mimeType:'application/pdf',body:{attachmentId:'fixture-'+context.state.messageIndex,size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:false,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow',canary:true,canaryMessageId:'abcdef92'}});
  assert.deepEqual(calls,['abcdef92']);assert.equal(audit.state.canaryPaused,true);assert.equal(audit.result.coverageComplete,false);
  assert.equal(audit.result.lastError.code,'audit_bridge_saved_unproven');
  const rows=(await db.query("SELECT message_id,disposition FROM exam_intake_receipt WHERE collector_id='fixture-bridge-canary' ORDER BY message_id")).rows;
  assert.equal(rows.length,2);assert(rows.every(row=>row.disposition==='pending'));
});

test('bad PDF signature is persisted as a source error, receipt stays pending and canary pauses without group task',async()=>{
  const cutoff=new Date(Date.now()-3600000).toISOString();let docId;
  const audit=await executeAudit('fixture-bridge-bad-signature',async(context,now)=>{
    if(context.target==='bridge'){
      const recorded=(await db.query("SELECT disposition FROM exam_intake_receipt WHERE collector_id='fixture-bridge-bad-signature'")).rows[0];assert.equal(recorded.disposition,'pending');
      const reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'gmail:audit@example.invalid',message_id:'abcdefa1',
        attachment_id:'gmail-part:["0","invalid-pdf"]',original_name:'original.pdf',mime_type:'application/pdf',received_at:new Date(now-60000).toISOString(),
        metadata:{provider:'gmail',mailbox:'audit@example.invalid',gmail_message_id:'abcdefa1',gmail_part_id:'0',gmail_attachment_id:'invalid-pdf'}})]);
      docId=reserved.document_id;await rpc('record_exam_document_source_error',[docId,'Arquivo sem assinatura PDF comprovada','Arquivo sem assinatura PDF; conferir o original']);return {completed:false};
    }
    return context.state.phase==='gmail_list'?{messages:[{id:'abcdefa1'}]}:{id:'abcdefa1',internalDate:String(now-60000),payload:{partId:'0',mimeType:'application/pdf',filename:'',body:{attachmentId:'invalid-pdf',size:100}}};
  },{config:{intakeCutoff:cutoff,continuous:true,allowScheduled:false,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow',canary:true,canaryMessageId:'abcdefa1'}});
  assert.equal(audit.state.canaryPaused,true);assert.equal(audit.result.coverageComplete,false);
  const doc=(await db.query('SELECT file_status,review_reason FROM exam_document WHERE id=$1',[docId])).rows[0];
  assert.equal(doc.file_status,'failed');assert.match(doc.review_reason,/assinatura PDF/);
  assert.equal((await db.query("SELECT disposition FROM exam_intake_receipt WHERE collector_id='fixture-bridge-bad-signature'")).rows[0].disposition,'pending');
  assert.equal(Number((await db.query("SELECT count(*) n FROM exam_document_delivery WHERE document_id=$1 AND destination='group'",[docId])).rows[0].n),0);
});

test('four attachments with one failure before reservation retry the missing fourth without duplicating the first three',async()=>{
  const cutoff=new Date(Date.now()-3600000).toISOString(),collector='fixture-four-retry',message='abcdefb1',docs=[];
  await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='audit-fixture-group'");
  const save=async(index,now)=>{
    const reserved=await rpc('reserve_exam_document_source',[JSON.stringify({channel:'email',account_id:'gmail:audit@example.invalid',message_id:message,
      attachment_id:'gmail-part:'+JSON.stringify([String(index),'loc-'+index]),original_name:'arquivo-'+index+'.pdf',mime_type:'application/pdf',received_at:new Date(now-60000).toISOString(),
      metadata:{provider:'gmail',mailbox:'audit@example.invalid',gmail_message_id:message,gmail_part_id:String(index),gmail_attachment_id:'loc-'+index}})]);
    const file={sha256:String(index+1).repeat(64),size_bytes:100,drive_file_id:'fixture-four-'+index,drive_folder_id:'fixture-private-folder'};
    const staged=await rpc('stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'fixture-four']);
    if(staged.claimed)await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
    return staged.document_id;
  };
  for(let i=0;i<3;i++)docs.push(await save(i,Date.now()));
  const config={intakeCutoff:cutoff,continuous:true,allowScheduled:true,overlapSeconds:300,maxRepeatedFailures:3,notificationMode:'home_only',
    prospective:true,recheckPending:true,bridgeEnabled:true,bridgeWorkflowId:'fixtureChildWorkflow',captureAttachmentDetails:true};
  let calls=0;
  const first=await executeAudit(collector,async(context,now)=>{
    if(context.target==='bridge'){calls++;assert.deepEqual(context.payload.targets,[{kind:'gmail_part',part_id:'3'}]);return {completed:false,issues:[{message_id:message,attachment_id:'gmail-part:["3","changed-locator"]',reason:'source_reservation_unproven'}]};}
    return context.state.phase==='gmail_list'?{messages:[{id:message}]}:{id:message,internalDate:String(now-60000),payload:{partId:'',mimeType:'multipart/mixed',headers:[{name:'From',value:'Fixture <sender@example.invalid>'}],
      parts:Array.from({length:4},(_,i)=>({partId:String(i),mimeType:'application/pdf',filename:'arquivo-'+i+'.pdf',body:{attachmentId:'loc-'+i,size:100}}))}};
  },{config});
  assert.equal(calls,1);assert.equal(first.result.coverageComplete,true);assert.equal(first.result.counts.saved,3);assert.equal(first.result.counts.pending,1);
  const before=(await db.query("SELECT attachment_id,disposition,document_id,reason_code FROM exam_intake_receipt WHERE collector_id=$1 ORDER BY attachment_id",[collector])).rows;
  assert.equal(before.length,4);assert.equal(before.filter(r=>r.disposition==='saved').length,3);const missing=before.find(r=>r.disposition==='pending');
  assert.equal(missing.attachment_id,'gmail-part:["3","loc-3"]');assert.equal(missing.document_id,null);assert.equal(missing.reason_code,'source_reservation_unproven');
  await db.exec('RESET ROLE');
  const details=(await db.query("SELECT position,display_name,mime_type,sender FROM exam_intake_receipt_detail d JOIN exam_intake_receipt r ON r.id=d.receipt_id WHERE r.collector_id=$1 ORDER BY position",[collector])).rows;
  await role('service_role');
  assert.equal(details.length,4);assert.equal(details[3].display_name,'arquivo-3.pdf');assert.equal(details[3].sender,'sender@example.invalid');
  const firstThree=await Promise.all(docs.map(async id=>(await db.query("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) items FROM exam_document_delivery t WHERE document_id=$1",[id])).rows[0].items));
  const second=await executeAudit(collector,async(context,now)=>{
    if(context.target==='bridge'){calls++;assert.deepEqual(context.payload.targets,[{kind:'gmail_part',part_id:'3'}]);docs.push(await save(3,now));return {completed:true};}
    return {messages:[],resultSizeEstimate:0};
  },{config:first.cfg,row:first.row});
  const after=(await db.query("SELECT disposition,document_id FROM exam_intake_receipt WHERE collector_id=$1",[collector])).rows;
  assert.equal(calls,2);assert.equal(after.filter(r=>r.disposition==='saved').length,4);assert(after.some(r=>r.document_id===docs[3]));
  assert.equal(second.result.coverageComplete,true);
  assert.deepEqual(await Promise.all(docs.slice(0,3).map(async id=>(await db.query("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) items FROM exam_document_delivery t WHERE document_id=$1",[id])).rows[0].items)),firstThree);
});
