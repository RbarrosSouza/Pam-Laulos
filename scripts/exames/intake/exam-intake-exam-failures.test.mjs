import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
let db,role,rpc; const member='20000000-0000-4000-8000-000000000001',outsider='20000000-0000-4000-8000-000000000002';
const ids={}; const one=async(sql,params=[])=>(await db.query(sql,params)).rows[0];
async function memberRole(id=member){await role('authenticated');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id]);}
async function createDoc(label,{channel='email',age=60,clinical=true,processing='completed',group='pending',review=false,groupException=null}={}){
 const row=await one("INSERT INTO exam_document(original_name,received_at,extracted_data,evidence,group_exception_reason) VALUES($1,now()-make_interval(mins=>$2),$3::jsonb,$4::jsonb,$5) RETURNING id",[label+'.pdf',age,JSON.stringify({exam_type:'Hemograma',pet_name:'Paciente teste',client_name:'Tutor teste'}),JSON.stringify([{field:'exam_type',page:1,excerpt:'Hemograma'}]),groupException]);ids[label]=row.id;
 await db.query("INSERT INTO exam_document_source(document_id,channel,account_id,message_id,attachment_id,received_at) VALUES($1,$2,'fixture', $3,'pdf',now()-make_interval(mins=>$4))",[row.id,channel,label,age]);
 await db.query("INSERT INTO exam_document_event(document_id,event_type,details) VALUES($1,'extraction_updated',$2::jsonb)",[row.id,JSON.stringify({classification:clinical?'exam':'review',single_patient:true})]);
 if(review)await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,$3::jsonb)",[row.id,member,JSON.stringify({classification:'exam'})]);
 if(processing)await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'processing',$2)",[row.id,processing]);
 if(group)await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'group',$2)",[row.id,group]);
 return row.id;
}
before(async()=>{
 ({db,role,rpc}=await collectionFixtureDB());await db.exec('RESET ROLE');
 for(const f of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql','20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql','20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql','20261027000023_exam_intake_receipts_incidents.sql','20261027000024_exam_hopelab_notice_snapshots.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 const helper=await readFile(new URL('../../../supabase/migrations/20261019000016_exam_hemogram_normalization.sql',import.meta.url),'utf8');
 await db.exec(helper.slice(helper.indexOf('CREATE FUNCTION public.exam_document_exam_component_heading'),helper.indexOf('REVOKE ALL ON FUNCTION public.exam_document_exam_component_heading')));
 await db.exec(await readFile(new URL('../../../supabase/migrations/20261028000031_exam_intake_exam_failures.sql',import.meta.url),'utf8'));
 const beforeUpgrade=await one("SELECT oid::text oid,proowner::text owner,proacl::text acl FROM pg_proc WHERE oid='public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure");
 await db.exec(await readFile(new URL('../../../supabase/migrations/20261028000035_exam_attention_scope_update.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../../supabase/migrations/20261028000037_exam_attention_unreadable_files.sql',import.meta.url),'utf8'));
 assert.deepEqual(await one("SELECT oid::text oid,proowner::text owner,proacl::text acl FROM pg_proc WHERE oid='public.get_exam_intake_exam_failures(integer,integer,timestamptz,uuid)'::regprocedure"),beforeUpgrade);
 await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[member,outsider]);await db.query("INSERT INTO exam_document_member(user_id,role) VALUES($1,'admin')",[member]);
 await db.query("UPDATE exam_document_configuration SET ingestion_enabled=true,group_destination_key='fixture-group',notification_cutoff=now()-interval '30 minutes',attention_cutoff=now()-interval '2 hours'");
 await createDoc('processing-failed',{processing:'failed'});await createDoc('processing-overdue',{processing:'pending'});
 await createDoc('group-failed',{group:'failed'});await createDoc('group-overdue');await createDoc('uncertain',{group:'uncertain'});
 await createDoc('fresh',{age:1});await createDoc('sent',{group:'sent'});await createDoc('waived',{group:'waived'});
 await createDoc('unknown',{clinical:false,group:'failed'});await createDoc('human-reviewed',{clinical:false,review:true,group:'failed'});
 await createDoc('inconclusive-processing-failed',{clinical:false,processing:'failed',group:null});
 const ruledOut=await createDoc('ruled-out',{clinical:false,processing:'failed',group:null});
 await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[ruledOut]);
 await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}'::jsonb)",[ruledOut,member]);
 const autoNotExam=await createDoc('auto-not-exam',{clinical:false,processing:'completed',group:null});await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[autoNotExam]);
 await createDoc('whatsapp-only',{channel:'whatsapp',group:'failed'});await createDoc('group-exception',{group:'failed',groupException:'operator-approved'});await createDoc('historical',{age:180,group:'failed'});
 await createDoc('synthetic',{group:'failed'});await db.query("UPDATE exam_document_source SET metadata='{\"synthetic_fixture\":true}'::jsonb WHERE document_id=$1",[ids.synthetic]);
});
after(async()=>{await db?.close()});
test('only authorized members may read the query; invalid pagination fails',async()=>{
 await role('anon');await assert.rejects(rpc('get_exam_intake_exam_failures',[10,0]),e=>e.code==='42501');
 await memberRole(outsider);await assert.rejects(rpc('get_exam_intake_exam_failures',[10,0]),e=>e.code==='42501');
 await memberRole();for(const a of [[0,0],[101,0],[5,-1]])await assert.rejects(rpc('get_exam_intake_exam_failures',a),/Invalid exam failure page/);
});
test('lists only evidenced email exams needing processing or group delivery, with explicit reasons',async()=>{
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]);assert.equal(v.contract,'exam_intake_exam_failures_v1');assert.equal(v.total,7);assert.equal(v.coverage_status,'unproven');
 assert.deepEqual(new Set(v.rows.map(x=>x.document_id)),new Set(['processing-failed','processing-overdue','group-failed','group-overdue','uncertain','human-reviewed','whatsapp-only'].map(k=>ids[k])));
 const row=k=>v.rows.find(x=>x.document_id===ids[k]);assert.equal(row('processing-failed').reason,'processing_failed');assert.equal(row('processing-overdue').reason,'processing_overdue');assert.equal(row('group-failed').reason,'group_failed');assert.equal(row('uncertain').status,'uncertain');
 assert.equal(v.unclassified_documents_total,3); // Unknown, failed extraction and auto-not-exam; human review is excluded.
 for(const x of v.rows){assert.equal(x.channel,x.document_id===ids['whatsapp-only']?'whatsapp':'email');assert.equal(x.pet_name,'Paciente teste');assert(!JSON.stringify(x).includes('lease_token'));}
});
test('pagination is bounded and the query is strictly read-only',async()=>{
 await memberRole();await db.exec('BEGIN; SET TRANSACTION READ ONLY;');const a=await rpc('get_exam_intake_exam_failures',[3,0]),b=await rpc('get_exam_intake_exam_failures',[3,3]),c=await rpc('get_exam_intake_exam_failures',[3,6]);await db.exec('ROLLBACK;');
 assert.equal(a.total,7);assert.equal(a.has_more,true);assert.equal(c.has_more,false);assert.equal(new Set([...a.rows,...b.rows,...c.rows].map(x=>x.document_id)).size,7);
});
test('confirmed blanks do not restore rejected extracted values',async()=>{
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document SET confirmed_data='{"+"\"pet_name\":null,\"tutor_name\":\"\",\"exam_type\":null}'::jsonb WHERE id=$1",[ids['human-reviewed']]);
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]);const x=v.rows.find(r=>r.document_id===ids['human-reviewed']);
 assert.equal(x.pet_name,null);assert.equal(x.client_name,null);assert.equal(x.exam_type,null);
});
test('group target and uncertain attempts are not hidden by other deliveries',async()=>{
 await db.exec('RESET ROLE');
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,destination_key,status) VALUES($1,'group','other-group','sent'),($2,'group','fixture-group','sent')",[ids['group-failed'],ids.uncertain]);
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]);
 assert.equal(v.rows.find(r=>r.document_id===ids['group-failed']).reason,'group_failed');
 assert.equal(v.rows.find(r=>r.document_id===ids.uncertain).reason,'group_delivery_uncertain');
});
test('cursor does not skip subsequent rows when a previous failure is resolved',async()=>{
 await memberRole();const all=await rpc('get_exam_intake_exam_failures',[100,0]);const first=await rpc('get_exam_intake_exam_failures',[2,0]);assert(first.next_cursor);
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=$1",[first.rows[0].document_id]);
 await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}'::jsonb)",[first.rows[0].document_id,member]);
 await memberRole();const rest=await rpc('get_exam_intake_exam_failures',[100,0,first.next_cursor.age_from,first.next_cursor.document_id]);
 assert.deepEqual(rest.rows.map(x=>x.document_id),all.rows.slice(2).map(x=>x.document_id));assert.equal(rest.next_cursor,null);
 await assert.rejects(rpc('get_exam_intake_exam_failures',[5,0,first.next_cursor.age_from,null]),/Invalid exam failure page/);
});
test('an unset attention cutoff cannot return a misleading empty queue and does not change delivery cutoff',async()=>{
 await db.exec('RESET ROLE');const old=(await one('SELECT notification_cutoff FROM exam_document_configuration')).notification_cutoff;
 await db.query('UPDATE exam_document_configuration SET attention_cutoff=NULL');await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]);
 assert.equal(v.attention_cutoff,null);assert.equal(v.coverage_status,'not_configured');assert.equal(v.total,0);assert.equal(v.channels.length,3);assert(v.channels.every(x=>x.activity==='not_configured'));
 await db.exec('RESET ROLE');assert.equal((await one('SELECT notification_cutoff FROM exam_document_configuration')).notification_cutoff.toISOString(),old.toISOString());
 await db.query("UPDATE exam_document_configuration SET attention_cutoff=now()-interval '2 hours'");
});
test('coverage requires all configured providers, verified contracts, recent operational sweeps and no time gaps',async()=>{
 await db.exec('RESET ROLE');
 for(const provider of ['gmail','outlook','chatwoot']){
   const name='coverage-fixture-'+provider;
   await db.query("INSERT INTO exam_collection_cursor(collector_id,scope_key,scope_manifest,revision,received_through) VALUES($1,$2,$3::jsonb,1,now()-interval '1 minute')",[name,'f'.repeat(64),JSON.stringify({provider,include_spam_trash:true,sender_policy:'all'})]);
   const sweep=await one("INSERT INTO exam_collection_sweep(collector_id,request_id,expected_revision,received_from,received_through,status,conclusive,committed_revision,expires_at,intake_mode,intake_counts) SELECT $1,gen_random_uuid(),0,attention_cutoff,now()-interval '1 minute','committed',true,1,now()+interval '1 hour','operational',$2::jsonb FROM exam_document_configuration RETURNING id",[name,JSON.stringify({coverageComplete:true,scanFinished:true})]);
   await db.query("INSERT INTO exam_intake_health(collector_id,provider,monitored,heartbeat_at,progress_at,last_success_at,last_sweep_id) VALUES($1,$2,true,now(),now(),now(),$3)",[name,provider,sweep.id]);
 }
 await db.query("UPDATE exam_document_configuration SET attention_gmail_collector_id='coverage-fixture-gmail',attention_outlook_collector_id='coverage-fixture-outlook',attention_chatwoot_collector_id='coverage-fixture-chatwoot'");
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query('UPDATE exam_document_configuration SET attention_coverage_verified=true');await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document SET identification_status='not_exam' WHERE id=ANY($1::uuid[])",[[ids.unknown,ids['inconclusive-processing-failed'],ids['auto-not-exam']]]);
 for(const id of [ids.unknown,ids['inconclusive-processing-failed'],ids['auto-not-exam']])await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}'::jsonb)",[id,member]);
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'proven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_cursor SET scope_manifest=jsonb_set(scope_manifest,'{sender_policy}','\"authorized_only\"') WHERE collector_id='coverage-fixture-chatwoot'");
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_cursor SET scope_manifest=jsonb_set(scope_manifest,'{sender_policy}','\"all\"') WHERE collector_id='coverage-fixture-chatwoot'");
 await db.exec('RESET ROLE');await db.query("INSERT INTO exam_collection_message(sweep_id,folder_id,message_id,intake_received_at,intake_manifest) SELECT id,'mailbox','empty-fixture',now()-interval '2 minutes','[]'::jsonb FROM exam_collection_sweep WHERE collector_id='coverage-fixture-gmail'");
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_message SET intake_manifest='[{\"attachment_id\":\"fixture\",\"artifact_kind\":\"attachment\"}]'::jsonb WHERE message_id='empty-fixture'");
 await db.query("INSERT INTO exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,disposition,reason_code) VALUES('coverage-fixture-gmail','mailbox','empty-fixture','fixture','attachment','excluded','nonclinical_unproven')");
 await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("DELETE FROM exam_intake_receipt WHERE message_id='empty-fixture'");await db.query("DELETE FROM exam_collection_message WHERE message_id='empty-fixture'");
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_sweep SET received_from=received_from+interval '1 minute' WHERE collector_id='coverage-fixture-gmail'");await memberRole();assert.equal((await rpc('get_exam_intake_exam_failures',[10,0])).coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_collection_sweep SET received_from=received_from-interval '1 minute' WHERE collector_id='coverage-fixture-gmail'");
 await db.query("UPDATE exam_intake_health SET heartbeat_at=now()-interval '1 hour' WHERE collector_id='coverage-fixture-outlook'");await memberRole();const stale=await rpc('get_exam_intake_exam_failures',[10,0]);assert.equal(stale.coverage_status,'unproven');assert.equal(stale.channels.find(x=>x.provider==='outlook').activity,'stale');assert.equal(stale.channels.find(x=>x.provider==='gmail').activity,'recent');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document_configuration SET attention_gmail_collector_id='different-fixture',attention_coverage_verified=true");
 assert.equal((await one('SELECT attention_coverage_verified FROM exam_document_configuration')).attention_coverage_verified,false);
});

test('saved unreadable PDFs and explicit clinical PDF preservation errors are actionable without inventing exam identity',async()=>{
 await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.role','service_role',false)");await db.query("UPDATE exam_document_configuration SET attention_cutoff=now()-interval '2 hours'");
 async function make(label,{saved=true,age=30,processing='failed',metadata={},extract=null,evidence=[],group=null,channel='email'}={}){
  const doc=await one("INSERT INTO exam_document(original_name,file_status,drive_file_id,sha256,size_bytes,extracted_data,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id",[label,saved?'saved':'failed',saved?'synthetic-drive':null,saved?label.padEnd(64,'a').slice(0,64):null,saved?100:null,JSON.stringify(extract||{}),JSON.stringify(evidence)]);
  await db.query("INSERT INTO exam_document_source(document_id,channel,account_id,message_id,attachment_id,received_at,metadata) VALUES($1,$2,'test-account',$3,'real-attachment',now()-make_interval(mins=>$4),$5::jsonb)",[doc.id,channel,label,age,JSON.stringify(metadata)]);
  if(processing)await db.query("INSERT INTO exam_document_delivery(document_id,destination,status,lease_until) VALUES($1,'processing',$2,CASE WHEN $2='reserved' THEN now()+interval '10 minutes' END)",[doc.id,processing]);
  if(group)await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'group',$2)",[doc.id,group]);
  if(extract)await db.query("INSERT INTO exam_document_event(document_id,event_type,details) VALUES($1,'extraction_updated','{\"classification\":\"review\",\"single_patient\":true}'::jsonb)",[doc.id]);
  return doc.id;
 }
 const blank=await make('a', {metadata:{},channel:'whatsapp'});
 const error=await make('b',{saved:false,metadata:{mime_type:'application/pdf',exam_candidate:true,original_name:'real.pdf'}});
 const generic=await make('c',{saved:false,metadata:{mime_type:'application/pdf'}});
 const fresh=await make('d',{age:2});
 const running=await make('e',{processing:'reserved'});
 const doc=await make('f',{processing:'completed',group:'pending',extract:{pet_name:'Pingo',client_name:'Cris'},evidence:[{field:'pet_name',page:1,excerpt:'Paciente: Pingo'},{field:'client_name',page:1,excerpt:'Tutor: Cris'}]});
 const badIdentity=await make('1',{processing:'completed',group:'pending',extract:{pet_name:'Pingo',client_name:'Cris'},evidence:[]});
 const ruled=await make('2');await db.query("INSERT INTO exam_document_event(document_id,event_type,actor_id,details) VALUES($1,'reviewed',$2,'{\"classification\":\"not_exam\"}'::jsonb)",[ruled,member]);
 await memberRole();const v=await rpc('get_exam_intake_exam_failures',[100,0]);const find=id=>v.rows.find(r=>r.document_id===id);
 assert.equal(find(blank).reason,'unreadable_file');assert.equal(find(blank).original_name,null);assert.equal(find(blank).pet_name,null);assert.equal(find(blank).channel,'whatsapp');
 assert.equal(find(error).reason,'unreadable_file');assert.equal(find(error).original_name,'real.pdf');
 for(const id of [generic,fresh,running,badIdentity,ruled])assert.equal(find(id),undefined);
 assert.equal(find(doc).reason,'review_file');assert.equal(find(doc).issue_kind,'processing');assert.equal(find(doc).pet_name,'Pingo');assert.equal(find(doc).client_name,'Cris');assert.equal(find(doc).exam_type,null);assert.equal(v.coverage_status,'unproven');
 await db.exec('RESET ROLE');await db.query("UPDATE exam_document SET confirmed_data='{\"pet_name\":null,\"client_name\":\"Outro nome\"}'::jsonb WHERE id=$1",[doc]);
 await memberRole();const revised=(await rpc('get_exam_intake_exam_failures',[100,0])).rows.find(r=>r.document_id===doc);assert.equal(revised.reason,'review_file');assert.equal(revised.pet_name,null);assert.equal(revised.client_name,null);
});

test('an attachment that fails before reservation has no document row to display individually',async()=>{
 await db.exec('RESET ROLE');
 await db.query("UPDATE exam_document_configuration SET attention_cutoff=now()-interval '2 hours',attention_gmail_collector_id='coverage-fixture-gmail'");
 const sweep=(await one("SELECT id FROM exam_collection_sweep WHERE collector_id='coverage-fixture-gmail' LIMIT 1")).id;
 await memberRole();const before=await rpc('get_exam_intake_exam_failures',[100,0]);
 await db.exec('RESET ROLE');
 await db.query("INSERT INTO exam_collection_message(sweep_id,folder_id,message_id,intake_received_at,intake_manifest) VALUES($1,'mailbox','pre-reserve-failure',now()-interval '30 minutes','[{\"attachment_id\":\"part-four\",\"artifact_kind\":\"attachment\"}]'::jsonb)",[sweep]);
 await db.query("INSERT INTO exam_intake_receipt(collector_id,partition_key,message_id,attachment_id,artifact_kind,disposition,reason_code) VALUES('coverage-fixture-gmail','mailbox','pre-reserve-failure','part-four','attachment','pending','source_origin_not_recorded')");
 await memberRole();const after=await rpc('get_exam_intake_exam_failures',[100,0]);
 assert.equal(after.unclassified_receipts_total,before.unclassified_receipts_total+1);
 assert.equal(after.total,before.total);assert(!after.rows.some(row=>row.message_id==='pre-reserve-failure'||row.attachment_id==='part-four'));
});
