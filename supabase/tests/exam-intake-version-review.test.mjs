import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

let db,rpc,role,releaseBefore,markBefore,serial=0;
const admin='10000000-0000-4000-8000-000000000001',vet='10000000-0000-4000-8000-000000000002',reception='10000000-0000-4000-8000-000000000003',outsider='10000000-0000-4000-8000-000000000004';
const pet='20000000-0000-4000-8000-000000000001',otherPet='20000000-0000-4000-8000-000000000002';
const sha=value=>createHash('sha256').update(value).digest('hex');
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
async function worker(){await role('service_role');await db.query("SELECT set_config('request.jwt.claim.sub','',false)");}
async function member(id=vet){await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);}
async function preserved(source,hash,v2){
 const reserved=await rpc(v2?'reserve_exam_intake_source':'reserve_exam_document_source',[JSON.stringify(source)]);
 const file={sha256:hash,size_bytes:123,drive_file_id:'synthetic-private-'+reserved.document_id,drive_folder_id:'synthetic-private-folder'};
 const staged=await rpc(v2?'stage_exam_intake_file':'stage_exam_document_file',[reserved.document_id,JSON.stringify(file),'review-fixture']);
 if(staged.claimed)await rpc('confirm_exam_document_file',[staged.document_id,JSON.stringify({...file,drive_file_id:staged.drive_file_id}),staged.lease_token]);
 return staged.document_id;
}
async function pair(){
 await worker();const key=String(++serial),relation=sha('relation-'+key),previousHash=sha('previous-'+key),currentHash=sha('current-'+key);
 const previousSource={channel:'email',account_id:'gmail:review@example.invalid',message_id:'hopelab-result:'+relation,attachment_id:'hopelab-link:'+relation,original_name:'Synthetic previous.pdf',received_at:new Date(Date.now()-120000).toISOString(),metadata:{provider:'hopelab_link',gmail_message_id:(serial*2).toString(16).padStart(16,'0'),link_sha256:relation}};
 const previous=await preserved(previousSource,previousHash,false);
 await db.query("UPDATE exam_document SET pet_id=$2,identification_status='confirmed',link_confirmed_by=$3,link_confirmed_at=now() WHERE id=$1",[previous,pet,admin]);
 const notice=(serial*2+1).toString(16).padStart(16,'0');
 const current=await preserved({...previousSource,message_id:notice,original_name:'Synthetic changed.pdf',received_at:new Date(Date.now()-60000).toISOString(),metadata:{...previousSource.metadata,gmail_message_id:notice,hopelab_notice_protocol:'gmail_notice_link_v2'}},currentHash,true);
 const hold=await one('SELECT * FROM exam_intake_document_hold WHERE document_id=$1',[current]);assert.equal(hold.state,'held');assert.equal(hold.previous_document_id,previous);
 return {current,previous,currentHash,previousHash};
}
const release=(p,reason='clinical_complement_confirmed',hash=p.currentHash)=>rpc('release_exam_intake_hold',[p.current,hash,reason]);
const review=p=>rpc('get_exam_intake_version_review',[p.current]);
async function immutableSnapshot(){
 const result={};for(const table of ['exam_document_source','exam_intake_snapshot','exam_document_delivery','exames'])result[table]=(await one('SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) hash FROM '+table+' t')).hash;
 return result;
}

before(async()=>{
 ({db,rpc,role}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const name of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql'])await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 releaseBefore=await one("SELECT proowner,proacl::text acl FROM pg_proc WHERE oid='public.release_exam_intake_hold(uuid,text,text)'::regprocedure");
 markBefore=await one("SELECT md5(pg_get_functiondef('public.mark_exam_document_correction(uuid,uuid,bigint,text)'::regprocedure)) body");
 await db.exec(await readFile(new URL('../migrations/20261027000027_exam_intake_version_review.sql',import.meta.url),'utf8'));
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2),($3),($4)',[admin,vet,reception,outsider]);
 await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin'),($2,'vet'),($3,'reception')",[admin,vet,reception]);
 await db.query('INSERT INTO pets(id,name) VALUES($1,\'Synthetic A\'),($2,\'Synthetic B\')',[pet,otherPet]);
 await worker();await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,enabled_destinations=ARRAY['drive','processing','group'],notification_cutoff=now()-interval '2 days',group_destination_key='synthetic-group'");
});
after(async()=>{await db?.close();});

test('installation preserves release owner/ACL and the existing clinical guard body',async()=>{
 await db.exec('RESET ROLE');assert.deepEqual(await one("SELECT proowner,proacl::text acl FROM pg_proc WHERE oid='public.release_exam_intake_hold(uuid,text,text)'::regprocedure"),releaseBefore);
 assert.deepEqual(await one("SELECT md5(pg_get_functiondef('public.mark_exam_document_correction(uuid,uuid,bigint,text)'::regprocedure)) body"),markBefore);
 const acl=await one("SELECT has_function_privilege('anon','public.get_exam_intake_version_review(uuid)','EXECUTE') anon,has_function_privilege('authenticated','public.get_exam_intake_version_review(uuid)','EXECUTE') member");assert.equal(acl.anon,false);assert.equal(acl.member,true);
});
test('only active members read review and only admin/vet can decide',async()=>{
 const p=await pair();await role('anon');await assert.rejects(review(p),e=>e.code==='42501');
 await member(outsider);await assert.rejects(review(p),e=>e.code==='42501');
 await member(reception);const view=await review(p);assert.equal(view.review_allowed,false);await assert.rejects(release(p),e=>e.code==='42501');
 await member(vet);assert.equal((await review(p)).review_allowed,true);
});
test('review payload has original hashes, status and private PDF identities without URLs or dispatch secrets',async()=>{
 const p=await pair();await member();const view=await review(p);
 assert.equal(view.contract,'exam_intake_version_review_v1');assert.equal(view.current.document_id,p.current);assert.equal(view.previous.document_id,p.previous);assert.equal(view.current.sha256,p.currentHash);assert.equal(view.can_link_previous,true);assert.equal(view.blocking_reason,null);assert.equal(view.hold.state,'held');
 for(const forbidden of ['drive_file_id','storage_path','lease_token','external_id','extracted_data','confirmed_data','https://'])assert(!JSON.stringify(view).includes(forbidden));
});
test('inconclusive is audited once and preserves hold, snapshots and deliveries',async()=>{
 const p=await pair();await worker();const before=await immutableSnapshot();await member();
 assert.equal((await release(p,'inconclusive')).hold_released,false);assert.equal((await release(p,'inconclusive')).hold_released,false);
 const view=await review(p);assert.equal(view.hold.state,'held');assert.equal(view.decision.reason_code,'inconclusive');
 await worker();assert.equal((await one('SELECT previous_document_id FROM exam_document WHERE id=$1',[p.current])).previous_document_id,null);assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='intake_version_review_inconclusive'",[p.current])).n),1);assert.deepEqual(await immutableSnapshot(),before);
});
test('confirmed complement reuses the clinical guard, releases once and never resets submitted/uncertain/sent deliveries',async()=>{
 const p=await pair();await worker();
 for(const status of ['sent','submitted','uncertain'])await db.query("INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,external_id,external_status) VALUES($1,'group',$2,$3,$4,$5)",[p.current,'preserve-'+status,status,'external-'+status,status==='sent'?'delivered':status]);
 const before=await immutableSnapshot();const previousDoc=await one('SELECT to_jsonb(d) value FROM exam_document d WHERE id=$1',[p.previous]);await member();
 assert.equal((await release(p)).hold_released,true);assert.equal((await release(p)).already_released,true);const view=await review(p);assert.equal(view.hold.state,'released');assert.equal(view.decision.reason_code,'clinical_complement_confirmed');assert.equal(view.review_allowed,false);
 await worker();const current=await one('SELECT * FROM exam_document WHERE id=$1',[p.current]);assert.equal(current.previous_document_id,p.previous);assert.equal(current.pet_id,null);assert.equal(current.sha256,p.currentHash);assert.equal(current.file_status,'saved');assert.deepEqual(await one('SELECT to_jsonb(d) value FROM exam_document d WHERE id=$1',[p.previous]),previousDoc);assert.deepEqual(await immutableSnapshot(),before);
 assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='intake_version_reviewed'",[p.current])).n),1);
 await member();await assert.rejects(release(p,'clinical_correction_confirmed'),/DECISION_ALREADY_RECORDED/);
});
test('confirmed correction uses its explicit reason and expected SHA fence',async()=>{
 const p=await pair();await member(admin);await assert.rejects(release(p,'clinical_correction_confirmed','f'.repeat(64)),/ORIGINAL_CHANGED/);assert.equal((await review(p)).hold.state,'held');assert.equal((await release(p,'clinical_correction_confirmed')).hold_released,true);assert.equal((await review(p)).decision.reason_code,'clinical_correction_confirmed');
});
test('unknown reason codes cannot release or silently waive a version',async()=>{
 const p=await pair();await member();for(const reason of ['approved','clinical_complement','clinical_correction','',null])await assert.rejects(release(p,reason),/DECISION_INVALID/);assert.equal((await review(p)).hold.state,'held');
});
test('current patient linkage and a conflicting patient both block confirmation without relaxing the existing guard',async()=>{
 for(const [linked,expected] of [[pet,'current_patient_already_linked'],[otherPet,'patient_conflict']]){
  const p=await pair();await db.query("UPDATE exam_document SET pet_id=$2,identification_status='confirmed',link_confirmed_by=$3,link_confirmed_at=now() WHERE id=$1",[p.current,linked,admin]);await member();const view=await review(p);assert.equal(view.can_link_previous,false);assert.equal(view.blocking_reason,expected);await assert.rejects(release(p),new RegExp(expected));assert.equal((await review(p)).hold.state,'held');assert.equal((await release(p,'inconclusive')).hold_released,false);
 }
});
test('unconfirmed previous patient, missing previous bytes and an existing current version link remain held',async()=>{
 for(const mode of ['unconfirmed','missing_bytes','already_linked']){
  const p=await pair();
  if(mode==='unconfirmed')await db.query("UPDATE exam_document SET pet_id=NULL,identification_status='unidentified' WHERE id=$1",[p.previous]);
  if(mode==='missing_bytes')await db.query("UPDATE exam_document SET file_status='failed' WHERE id=$1",[p.previous]);
  if(mode==='already_linked')await db.query('UPDATE exam_document SET previous_document_id=$2 WHERE id=$1',[p.current,p.previous]);
  await member();const view=await review(p);assert.equal(view.can_link_previous,false);await assert.rejects(release(p),/REVIEW_BLOCKED/);assert.equal((await review(p)).hold.state,'held');
 }
});
test('ancestry cycles are reported before invoking the existing recursive clinical guard',async()=>{
 const p=await pair();await db.query('UPDATE exam_document SET previous_document_id=$2 WHERE id=$1',[p.previous,p.current]);await member();assert.equal((await review(p)).blocking_reason,'version_lineage_unresolved');await assert.rejects(release(p),/version_lineage_unresolved/);assert.equal((await review(p)).hold.state,'held');
});
