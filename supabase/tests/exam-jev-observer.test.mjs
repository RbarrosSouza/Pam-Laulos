import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db,serial=0;
const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
const one=async(sql,args=[])=>(await query(sql,args))[0];
const rpc=async(name,args)=>(await one(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).value;
const role=async name=>db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role','${name}',false);SET ROLE ${name}`);
const reserve=()=>rpc('reserve_exam_jev_observation',['synthetic-observer']);
const begin=t=>rpc('begin_exam_jev_observation',[t.id,t.lease_token]);
const finish=(t,result)=>rpc('complete_exam_jev_observation',[t.id,t.lease_token,result]);
async function document({size=123,created='2026-11-05T12:00:00Z'}={}){
 const id='11111111-1111-4111-8111-'+String(++serial).padStart(12,'0');
 await db.query("INSERT INTO exam_document(id,file_status,size_bytes,sha256,drive_file_id,identification_status) VALUES($1,'saved',$2,$3,$4,'suggested')",[id,size,String(serial).padStart(64,'a'),'synthetic-'+serial]);
 await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'processing','completed')",[id]);
 await db.query("INSERT INTO exam_document_event(document_id,event_type,created_at) VALUES($1,'extraction_updated',$2)",[id,created]);
 return id;
}
const snapshot=async()=>JSON.stringify(await one("SELECT (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM exam_document d) documents,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM exam_document_delivery t) deliveries"));
before(async()=>{
 db=new PGlite();await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE TABLE exam_document(id uuid PRIMARY KEY,file_status text,size_bytes bigint,sha256 text,drive_file_id text,identification_status text,
 deletion_state text,canonical_document_id uuid,pet_id uuid,confirmed_data jsonb DEFAULT '{}',group_ready boolean DEFAULT false);
 CREATE TABLE exam_document_event(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,document_id uuid REFERENCES exam_document(id),event_type text,created_at timestamptz DEFAULT now());
 CREATE TABLE exam_document_delivery(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),document_id uuid REFERENCES exam_document(id),destination text,status text,
 lease_until timestamptz,attempts integer DEFAULT 0,max_attempts integer DEFAULT 5,next_attempt_at timestamptz DEFAULT now());
 CREATE TABLE exam_document_configuration(enabled_destinations text[]);INSERT INTO exam_document_configuration VALUES(ARRAY['drive','processing','group','nexus']);
 CREATE TABLE exam_pipeline_worker(stage text,lease_until timestamptz);
 CREATE FUNCTION require_exam_document_service() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service required';END IF;END$$;
 CREATE FUNCTION exam_document_group_dispatch_snapshot(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('eligible',group_ready) FROM exam_document WHERE id=$1$$;
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
 await db.exec(await readFile(new URL('../migrations/20261105000103_exam_jev_observer.sql',import.meta.url),'utf8'));
 await role('service_role');
});
beforeEach(async()=>{
 await db.exec('RESET ROLE;TRUNCATE exam_jev_observation,exam_document_event,exam_document_delivery,exam_document,exam_pipeline_worker CASCADE;');
 await role('service_role');await db.exec("UPDATE exam_jev_observer_configuration SET enabled=true,observe_after='2026-11-05T00:00:00Z';UPDATE exam_document_configuration SET enabled_destinations=ARRAY['drive','processing','group','nexus'];");
});
after(async()=>{await db?.close();});
test('observer is private and pause/cutoff prevent queue creation',async()=>{
 for(const name of ['anon','authenticated']){
  assert.equal((await one("SELECT has_function_privilege($1,'public.reserve_exam_jev_observation(text)','EXECUTE') ok",[name])).ok,false);
  await role(name);await assert.rejects(db.query('SELECT * FROM exam_jev_observation'),{code:'42501'});await role('service_role');
 }
 await document({created:'2026-11-04T12:00:00Z'});assert.equal((await reserve()).task,null);
 await document();await db.exec('UPDATE exam_jev_observer_configuration SET enabled=false');assert.equal((await reserve()).paused,true);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_jev_observation')).n),0);
});
test('one observation is fenced before model call, normalized, and never alters clinical state',async()=>{
 await document();const before=await snapshot();const task=(await reserve()).task;assert(task);
 assert.equal((await reserve()).busy,true);assert.equal((await begin(task)).allowed,true);assert.equal((await begin(task)).allowed,false);
 await assert.rejects(finish(task,{status:'completed',route:'general_extraction',confidence:2,model:'typesafe/jev-1.14'}),/decision invalid/);
 const result=await finish(task,{status:'completed',route:'general_extraction',confidence:0.9,model:'typesafe/jev-1.14',cost_usd:0.001,duration_ms:5});assert.equal(result.recorded,true);
 assert.equal(await snapshot(),before);assert.equal((await reserve()).task,null);
 assert.equal((await finish(task,{status:'failed',error_code:'late_response'})).already_finished,true);
});
test('same PDF is not charged again after a new extraction event or a terminal failure',async()=>{
 const id=await document(),task=(await reserve()).task;await finish(task,{status:'failed',error_code:'original_unavailable'});
 await db.query("INSERT INTO exam_document_event(document_id,event_type) VALUES($1,'extraction_updated')",[id]);
 assert.equal((await reserve()).task,null);assert.equal(Number((await one('SELECT count(*) n FROM exam_jev_observation')).n),1);
});
test('active and actionable primary work wins; paused destinations do not starve observer',async()=>{
 const id=await document();await db.query("INSERT INTO exam_document_delivery(document_id,destination,status) VALUES($1,'drive','pending')",[id]);
 assert.equal((await reserve()).busy,true);
 await db.exec("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing']");assert((await reserve()).task);
});
test('a primary worker arriving before begin cancels observation without retry',async()=>{
 await document();const task=(await reserve()).task;
 await db.exec("INSERT INTO exam_pipeline_worker VALUES('processing',now()+interval '10 minutes')");
 assert.deepEqual(await begin(task),{allowed:false,reason:'primary_preempted'});
 await db.exec('DELETE FROM exam_pipeline_worker');assert.equal((await reserve()).task,null);
 assert.equal((await one('SELECT status FROM exam_jev_observation')).status,'skipped');
});
test('expired reservations and started calls are terminal, never replayed',async()=>{
 await document();let task=(await reserve()).task;
 await db.query("UPDATE exam_jev_observation SET lease_until=now()-interval '1 second' WHERE id=$1",[task.id]);
 assert.equal((await reserve()).task,null);assert.equal((await one('SELECT status FROM exam_jev_observation WHERE id=$1',[task.id])).status,'failed');
 await document();task=(await reserve()).task;await begin(task);
 await db.query("UPDATE exam_jev_observation SET lease_until=now()-interval '1 second' WHERE id=$1",[task.id]);
 assert.equal((await reserve()).task,null);assert.equal((await one('SELECT status FROM exam_jev_observation WHERE id=$1',[task.id])).status,'uncertain');
});
test('changed/deleted documents cannot start and large originals stay outside this pilot',async()=>{
 await document({size:2097153});assert.equal((await reserve()).task,null);
 const id=await document();const task=(await reserve()).task;
 await db.query("UPDATE exam_document SET deletion_state='deleted' WHERE id=$1",[id]);assert.equal((await begin(task)).reason,'document_changed');
});
