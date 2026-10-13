import assert from 'node:assert/strict';

// Runs against the same real SQL/RLS/legacy schema as exam-documents.test.mjs.
// PGlite is single-connection: production Postgres contention remains a separate gate.
export async function stagingJournalChecks({ db, check, rpc, source, row, role, staff, preserve }) {
  const identity = (message) => ({ channel: 'email', account_id: 'fixture-account', message_id: message, attachment_id: 'attachment' });
  const file = { sha256: '9'.repeat(64), size_bytes: 123 };
  const begin = (message, bytes = file, scope = 'fixture-workspace:fixture-account') =>
    rpc('begin_exam_document_staging', [JSON.stringify(identity(message)), JSON.stringify(bytes), scope, 45]);
  const nonces = new Map();
  const result = (id, extra = {}, nonce = nonces.get(id) ?? crypto.randomUUID()) => rpc('record_exam_document_staging', [id, nonce, JSON.stringify({state:'reported', ...file, helper_reference_sha256:'a'.repeat(64), ...extra})]);
  let origin, grant;
  await role('service_role');
  await db.query("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing','drive']");
  await check('staging cannot start before the origin is durably reserved', async () => {
    await assert.rejects(begin('staging-missing-origin'), /Reservar origem/);
  });
  await check('staging rejects absent/invalid contract fields without a dispatch record', async () => {
    await source('staging-invalid');
    for (const bytes of [{}, {...file, size_bytes: 0}, {...file, size_bytes:20971521}, {...file, size_bytes:'123'}, {...file, s3key:'must-not-store'}]) {
      await assert.rejects(begin('staging-invalid', bytes));
    }
    for (const scope of [null,'','bad scope']) await assert.rejects(begin('staging-invalid', file, scope));
    for (const deadline of [null,0,121]) await assert.rejects(rpc('begin_exam_document_staging', [JSON.stringify(identity('staging-invalid')),JSON.stringify(file),'fixture-scope',deadline]));
    assert.equal(Number((await row('SELECT count(*) n FROM exam_document_staging_operation')).n),0);
  });
  await check('first grant persists started before the caller can dispatch a helper', async () => {
    origin = await source('staging-once'); grant = await begin('staging-once');
    nonces.set(grant.operation_id, grant.dispatch_nonce);
    assert.equal(grant.dispatch_allowed,true); assert.equal(grant.ready_for_drive,false);
    const stored = await row('SELECT * FROM exam_document_staging_operation WHERE id=$1',[grant.operation_id]);
    const savedSource=await row('SELECT * FROM exam_document_source WHERE id=$1',[grant.source_id]);
    assert.equal(savedSource.document_id,origin.document_id);assert.equal(stored.source_id,savedSource.id);
    assert.equal(stored.status,'started');assert.equal(stored.helper_reference_sha256,null);
    assert.equal(stored.sha256,file.sha256);assert.equal(Number(stored.size_bytes),123);
  });
  await check('two reservations for the same origin obtain one dispatch grant', async () => {
    await source('staging-two-workers');
    const grants=await Promise.all([begin('staging-two-workers'),begin('staging-two-workers')]);
    assert.equal(grants.filter(g=>g.dispatch_allowed).length,1);
    assert.equal(grants[0].operation_id,grants[1].operation_id);
    assert.equal(grants.find(g=>!g.dispatch_allowed).dispatch_nonce,undefined);
  });
  await check('a lost begin acknowledgement stays HOLD on replay', async () => {
    const replay=await begin('staging-once');
    assert.equal(replay.dispatch_allowed,false);assert.equal(replay.operation_id,grant.operation_id);
    assert.equal(replay.status,'started');
  });
  await check('source-only begin protects the full Workbench bridge without a worker credential there', async () => {
    await source('staging-before-download');
    const args=[JSON.stringify(identity('staging-before-download')),null,'fixture-scope',45];
    const early=await rpc('begin_exam_document_staging',args);
    assert.equal(early.dispatch_allowed,true);
    const stored=await row('SELECT * FROM exam_document_staging_operation WHERE id=$1',[early.operation_id]);
    assert.equal(stored.sha256,null);assert.equal(stored.size_bytes,null);
    const unknown=await rpc('record_exam_document_staging',[early.operation_id,early.dispatch_nonce,JSON.stringify({state:'uncertain',error_code:'HELPER_UNKNOWN'})]);
    assert.equal(unknown.status,'uncertain');
    assert.equal((await rpc('begin_exam_document_staging',args)).dispatch_allowed,false);
    await rpc('record_exam_document_staging',[early.operation_id,early.dispatch_nonce,JSON.stringify({state:'reported',...file,helper_reference_sha256:'a'.repeat(64)})]);
    const bound=await row('SELECT * FROM exam_document_staging_operation WHERE id=$1',[early.operation_id]);
    assert.equal(bound.sha256,file.sha256);assert.equal(Number(bound.size_bytes),123);
    await assert.rejects(rpc('record_exam_document_staging',[early.operation_id,early.dispatch_nonce,JSON.stringify({state:'reported',...file,sha256:'b'.repeat(64),helper_reference_sha256:'a'.repeat(64)})]),/bytes diferentes/);
    assert.equal((await rpc('begin_exam_document_staging',args)).dispatch_allowed,false);
  });
  await check('elapsed deadline does not recreate or release staging', async () => {
    await db.query("UPDATE exam_document_staging_operation SET started_at=now()-interval '2 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[grant.operation_id]);
    assert.equal((await begin('staging-once')).dispatch_allowed,false);
  });
  await check('provider scope/hash/size changes cannot bypass the prior operation', async () => {
    await assert.rejects(begin('staging-once',file,'a-new-namespace'),/Identidade de staging mudou/);
    await assert.rejects(begin('staging-once',{...file,sha256:'b'.repeat(64)}),/Identidade de staging mudou/);
    await assert.rejects(begin('staging-once',{...file,size_bytes:124}),/Identidade de staging mudou/);
  });
  await check('unknown or mismatched result identities are refused', async () => {
    await assert.rejects(result(crypto.randomUUID()),/não encontrada/);
    await assert.rejects(result(grant.operation_id,{sha256:'b'.repeat(64)}),/bytes diferentes/);
    await assert.rejects(result(grant.operation_id,{size_bytes:124}),/bytes diferentes/);
    await assert.rejects(result(grant.operation_id,{},crypto.randomUUID()),/Recibo de staging divergente/);
    await assert.rejects(result(grant.operation_id,{},null),/Recibo de staging divergente/);
  });
  await check('only bounded sanitized staging evidence is accepted', async () => {
    for (const extra of [{state:'failed'}, {helper_reference_sha256:'raw-key'}, {s3key:'secret-fixture'}, {url:'https://fixture.invalid/private'}, {error_code:'raw-provider-error'}, {size_bytes:'123'}]) {
      await assert.rejects(result(grant.operation_id,extra));
    }
    assert.equal((await row('SELECT status FROM exam_document_staging_operation WHERE id=$1',[grant.operation_id])).status,'started');
  });
  await check('uncertain staging survives another authenticated worker and remains HOLD', async () => {
    await result(grant.operation_id,{state:'uncertain',helper_reference_sha256:null,error_code:'DEADLINE'});
    const again=await begin('staging-once');
    assert.equal(again.status,'uncertain');assert.equal(again.dispatch_allowed,false);
    assert.equal((await row('SELECT file_status FROM exam_document WHERE id=$1',[origin.document_id])).file_status,'pending');
  });
  await check('late helper result records evidence but never authorizes another dispatch or Drive', async () => {
    const late=await result(grant.operation_id);
    assert.equal(late.status,'reported');assert.equal(late.dispatch_allowed,false);assert.equal(late.ready_for_drive,false);
    assert.equal((await begin('staging-once')).dispatch_allowed,false);
    assert.equal((await row('SELECT file_status FROM exam_document WHERE id=$1',[origin.document_id])).file_status,'pending');
  });
  await check('a delayed timeout cannot erase a previously reported helper result', async () => {
    assert.equal((await result(grant.operation_id,{state:'uncertain',helper_reference_sha256:null,error_code:'RESULT_LOST'})).status,'reported');
    assert.equal((await result(grant.operation_id)).status,'reported');
    await assert.rejects(result(grant.operation_id,{helper_reference_sha256:'b'.repeat(64)}),/Referência de staging mudou/);
  });
  await check('source canonicalization preserves the original operation barrier', async () => {
    const canonical=await source('staging-canonical');await preserve(canonical.document_id,file.sha256);
    await rpc('stage_exam_document_file',[origin.document_id,JSON.stringify({...file,drive_file_id:'unused-origin-drive',drive_folder_id:'fixture-folder'}),'fixture-worker']);
    const shifted=await row('SELECT * FROM exam_document_source WHERE id=$1',[grant.source_id]);
    assert.equal(shifted.document_id,canonical.document_id);
    const replay=await begin('staging-once');assert.equal(replay.operation_id,grant.operation_id);assert.equal(replay.dispatch_allowed,false);
    assert.equal(replay.document_id,canonical.document_id);
  });
  await check('unresolved helper bytes cannot contradict a subsequently preserved origin', async () => {
    const fresh=await source('staging-origin-preserved-mid-flight');
    const grant=await rpc('begin_exam_document_staging',[JSON.stringify(identity('staging-origin-preserved-mid-flight')),null,'fixture-scope',45]);
    await preserve(fresh.document_id,'c'.repeat(64));
    await assert.rejects(rpc('record_exam_document_staging',[grant.operation_id,grant.dispatch_nonce,JSON.stringify({state:'reported',...file,helper_reference_sha256:'a'.repeat(64)})]),/diverge do documento/);
    const stored=await row('SELECT * FROM exam_document_staging_operation WHERE id=$1',[grant.operation_id]);
    assert.equal(stored.sha256,null);assert.equal(stored.status,'started');
  });
  await check('a preserved new origin skips helper dispatch without inventing a staging result', async () => {
    const saved=await source('staging-already-preserved');await preserve(saved.document_id,'c'.repeat(64));
    const noDispatch=await begin('staging-already-preserved',{...file,sha256:'c'.repeat(64)});
    assert.equal(noDispatch.dispatch_allowed,false);assert.equal(noDispatch.reason,'original_already_preserved');
    assert.equal(noDispatch.operation_id,undefined);
  });
  await check('new Drive lease and reconciliation cannot release a started helper operation', async () => {
    const fresh=await source('staging-new-drive-lease');const bytes={...file,sha256:'0'.repeat(64)};
    const dispatch=await begin('staging-new-drive-lease',bytes);
    const staged=await rpc('stage_exam_document_file',[fresh.document_id,JSON.stringify({...bytes,drive_file_id:'fixture-new-lease',drive_folder_id:'fixture-folder'}),'fixture-worker']);
    assert.equal(staged.claimed,true);
    await db.query("UPDATE exam_document_delivery SET lease_until=now()-interval '1 minute' WHERE id=$1",[staged.delivery_id]);
    await rpc('reconcile_exam_document_tasks',[]);
    const replacement=await rpc('stage_exam_document_file',[fresh.document_id,JSON.stringify({...bytes,drive_file_id:'fixture-new-lease',drive_folder_id:'fixture-folder'}),'fixture-worker-2']);
    assert.equal(replacement.claimed,true);assert.notEqual(replacement.lease_token,staged.lease_token);
    assert.equal((await row('SELECT status FROM exam_document_staging_operation WHERE id=$1',[dispatch.operation_id])).status,'started');
    const held=await begin('staging-new-drive-lease',bytes);assert.equal(held.dispatch_allowed,false);assert.equal(held.operation_id,dispatch.operation_id);
  });
  await check('anonymous cannot read or invoke the staging journal', async () => {
    await role('anon');await assert.rejects(db.query('SELECT * FROM exam_document_staging_operation'));
    await assert.rejects(begin('staging-once'));await assert.rejects(result(grant.operation_id));
  });
  await check('even an authorized vet cannot operate the worker staging journal', async () => {
    await role('authenticated',staff);await assert.rejects(db.query('SELECT * FROM exam_document_staging_operation'));
    await assert.rejects(begin('staging-once'));await assert.rejects(result(grant.operation_id));
  });
  await role('service_role');
  await check('dispatch records retain no raw helper key, URL, authorization or error text', async () => {
    const serialized=JSON.stringify((await db.query('SELECT * FROM exam_document_staging_operation')).rows);
    assert.doesNotMatch(serialized,/s3key|https:\/\/|Authorization|raw-provider-error/);
    const cols=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='exam_document_staging_operation'")).rows.map(r=>r.column_name);
    assert.deepEqual(cols.filter(c=>/key|url|token/.test(c)),[]);
  });
}
