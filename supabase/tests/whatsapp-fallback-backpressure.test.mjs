import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{PGlite}=require('@electric-sql/pglite');
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const migration=await read('../migrations/20261112020832_exam_fallback_backpressure.sql');
let db,originalAcl,originalConfiguration;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const rpc=async(name,args=[]) => (await one(`SELECT public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).result;
const state=()=>one('SELECT * FROM exam_fallback_runtime');
const claim=()=>rpc('claim_exam_fallback_run',['fallback:test',100]);
const checkpoint=(run,health='healthy',code=null,completed=true,scan={},request=null)=>rpc('checkpoint_exam_fallback_run_health',[run.run_token,JSON.stringify(scan),completed,code,health,request]);
const expireCooldown=()=>db.exec("UPDATE exam_fallback_runtime SET cooldown_until=clock_timestamp()-interval '1 second'");
const response=(request,status=503,timedOut=false,error=null)=>db.query('INSERT INTO net._http_response(id,status_code,timed_out,error_msg) VALUES($1,$2,$3,$4)',[request,status,timedOut,error]);
async function consume(request) {
 // Synthetic test-only headers; production reconciliation never reads them.
 const queued=await one('SELECT headers FROM net.http_request_queue WHERE id=$1',[request]);
 return rpc('consume_exam_fallback_scheduler_trigger',[queued.headers['x-exam-fallback-nonce'],Number(queued.headers['x-exam-fallback-timestamp'])]);
}
before(async()=>{
 db=new PGlite();
 await db.exec(`
 CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA vault; CREATE SCHEMA cron; CREATE SCHEMA net;
 CREATE FUNCTION public.require_exam_document_service() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service required' USING ERRCODE='42501'; END IF; END$$;
 SELECT set_config('request.jwt.claim.role','service_role',false);
 CREATE TABLE public.exam_fallback_configuration(singleton boolean PRIMARY KEY DEFAULT true,enabled boolean DEFAULT false,source_account_id text,source_conversation_id text,received_from timestamptz);
 INSERT INTO exam_fallback_configuration VALUES(true,false,'chatwoot:1:inbox:2','3','2026-11-01T00:00:00Z');
 CREATE TABLE public.exam_document_configuration(singleton boolean PRIMARY KEY DEFAULT true,ingestion_enabled boolean DEFAULT true,enabled_destinations text[] DEFAULT ARRAY['group'],notification_cutoff timestamptz DEFAULT now(),group_destination_key text DEFAULT 'synthetic-group');
 INSERT INTO exam_document_configuration(singleton) VALUES(true);
 CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
 INSERT INTO vault.decrypted_secrets VALUES('exam_whatsapp_fallback_trigger_key','synthetic-test-key-only-not-a-production-credential');
 CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(md5($1)||md5($1),'hex')$$;
 CREATE FUNCTION extensions.hmac(bytea,bytea,text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(repeat('ab',32),'hex')$$;
 CREATE TABLE net.http_request_queue(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,body jsonb,headers jsonb,timeout_milliseconds int);
 CREATE TABLE net._http_response(id bigint,status_code integer,timed_out boolean,error_msg text,created timestamptz DEFAULT clock_timestamp());
 CREATE INDEX ON net._http_response(created);
 CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}',params jsonb DEFAULT '{}',headers jsonb DEFAULT '{}',timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$INSERT INTO net.http_request_queue(url,body,headers,timeout_milliseconds) VALUES($1,$2,$4,$5) RETURNING id$$;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text,username text DEFAULT current_user,database text DEFAULT current_database(),command text,schedule text,active boolean DEFAULT true,UNIQUE(jobname,username));
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname,username) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING jobid$$;
 CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET schedule=coalesce($2,cron.job.schedule),active=coalesce($6,cron.job.active) WHERE jobid=$1$$;
 CREATE TABLE clinical_preservation_fixture(id integer PRIMARY KEY,queue_state text,receipt text);
 INSERT INTO clinical_preservation_fixture VALUES(1,'pending','unchanged');
 `);
 const original=await read('../migrations/20261103000044_exam_whatsapp_fallback.sql');
 await db.exec(original.slice(original.indexOf('CREATE TABLE public.exam_fallback_runtime'),original.indexOf('CREATE FUNCTION public.list_exam_fallback_group_reconciliation')));
 await db.exec(await read('../operations/exam-whatsapp-fallback-scheduler.sql'));
 await rpc('set_exam_fallback_schedule',[true]);
 await db.exec('REVOKE ALL ON FUNCTION claim_exam_fallback_run(text,integer),checkpoint_exam_fallback_run(uuid,jsonb,boolean,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION claim_exam_fallback_run(text,integer),checkpoint_exam_fallback_run(uuid,jsonb,boolean,text) TO service_role');
 originalAcl=await one("SELECT proowner,proacl::text acl FROM pg_proc WHERE oid='public.dispatch_exam_fallback_scheduled_run()'::regprocedure");
 originalConfiguration=await one('SELECT * FROM exam_fallback_configuration');
 await db.exec(migration);
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
 await db.exec(`RESET ROLE; DELETE FROM net.http_request_queue; DELETE FROM net._http_response; DELETE FROM exam_fallback_scheduler_nonce;
 UPDATE exam_fallback_runtime SET worker=NULL,run_token=NULL,run_until=NULL,scan='{}',last_started_at=NULL,last_checkpoint_at=NULL,last_completed_at=NULL,last_error_code=NULL,
 backpressure_enabled=true,failure_count=0,cooldown_until=NULL,last_failure_at=NULL,last_healthy_at=NULL,active_scheduler_request_id=NULL;`);
});

test('migration preserves active cron, cutoff, installed dispatcher ACL/owner and clinical state',async()=>{
 assert.deepEqual(await one("SELECT proowner,proacl::text acl FROM pg_proc WHERE oid='public.dispatch_exam_fallback_scheduled_run()'::regprocedure"),originalAcl);
 assert.deepEqual(await one('SELECT * FROM exam_fallback_configuration'),originalConfiguration);
 assert.deepEqual(await one("SELECT active,schedule FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'"),{active:true,schedule:'* * * * *'});
 assert.deepEqual(await one('SELECT * FROM clinical_preservation_fixture'),{id:1,queue_state:'pending',receipt:'unchanged'});
 for(const role of ['anon','authenticated','service_role']) {
  await db.exec('SET ROLE '+role);
  await assert.rejects(rpc('apply_exam_fallback_health',['healthy',null,null,new Date().toISOString()]),e=>e.code==='42501');
  await assert.rejects(rpc('reconcile_exam_fallback_scheduler_health'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
 }
});

test('consecutive infrastructure failures back off 1/2/4/8/15m, never retry early, then reset on a healthy partial probe',async()=>{
 for(const [i,base] of [60,120,240,480,900,900].entries()) {
  await expireCooldown(); const run=await claim();assert.equal(run.claimed,true);
  const result=await checkpoint(run,'transient_failure','fallback_backend_unavailable',false);
  assert.equal(result.failure_count,i+1);
  const timing=await one('SELECT extract(epoch FROM cooldown_until-last_failure_at)::float8 delay FROM exam_fallback_runtime');
  assert(timing.delay>=base && timing.delay<=Math.min(900,base+15),String(timing.delay));
  assert.equal((await claim()).reason,'backend_cooldown');
  assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);
 }
 await expireCooldown(); const run=await claim();
 const scan={cursor:null,window_start:'2026-11-01T00:00:00.000Z',window_end:'2026-11-02T00:00:00.000Z'};
 const result=await checkpoint(run,'healthy',null,false,scan);
 assert.equal(result.failure_count,0);assert.equal(result.cooldown_until,null);assert.deepEqual(result.scan,scan);
 assert.equal((await state()).last_completed_at,null);
});

test('item failures and local deadlines remain neutral; erroneous healthy or transient classification is rejected',async()=>{
 let run=await claim();await checkpoint(run,'transient_failure','fallback_backend_timeout',false);
 await expireCooldown();run=await claim();
 await assert.rejects(checkpoint(run,'healthy','pdf_hash_mismatch',false),e=>e.code==='22023');
 await assert.rejects(checkpoint(run,'transient_failure','pdf_hash_mismatch',false),e=>e.code==='22023');
 await assert.rejects(checkpoint(run,'transient_failure','fallback_scheduler_http_unavailable',false),e=>e.code==='22023');
 await checkpoint(run,'neutral','pdf_hash_mismatch',false);
 assert.equal((await state()).failure_count,1);
 run=await claim();await checkpoint(run,'neutral','fallback_run_deadline',false);
 assert.equal((await state()).failure_count,1);
});

test('current lease admits one probe; stale token or unrelated request cannot alter cooldown or release it',async()=>{
 const results=await Promise.all([claim(),claim(),claim()]);
 assert.equal(results.filter(r=>r.claimed).length,1);assert(results.filter(r=>!r.claimed).every(r=>r.reason==='run_active'));
 const run=results.find(r=>r.claimed),before=await state();
 await assert.rejects(checkpoint({run_token:crypto.randomUUID()},'transient_failure','fallback_backend_timeout',false),e=>e.code==='PT409');
 await assert.rejects(checkpoint(run,'healthy',null,true,{},999999),e=>e.code==='PT409');
 assert.deepEqual(await state(),before);
 await db.exec("UPDATE exam_fallback_runtime SET run_until=clock_timestamp()-interval '1 second'");
 const next=await claim();await assert.rejects(checkpoint(run),e=>e.code==='PT409');
 await checkpoint(next);assert.equal((await state()).failure_count,0);
});

test('failed request before claim opens cooldown from pg_net status and is counted only once',async()=>{
 const request=await rpc('dispatch_exam_fallback_scheduled_run');assert(request);
 await response(request,503);
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);
 assert.equal((await state()).failure_count,1);
 for(let i=0;i<3;i++)assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);
 assert.equal((await state()).failure_count,1);
 assert.equal((await one('SELECT health_outcome FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).health_outcome,'transient_failure');
});

test('explicit manual claim never binds another consumed scheduler nonce',async()=>{
 const request=await rpc('dispatch_exam_fallback_scheduled_run');await consume(request);
 const run=await rpc('claim_exam_fallback_run_health',['fallback:manual',100,null]);
 assert.equal((await state()).active_scheduler_request_id,null);
 await assert.rejects(checkpoint(run,'healthy',null,true,{},request),e=>e.code==='PT409');
 await checkpoint(run);
 assert.equal((await one('SELECT health_observed_at FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).health_observed_at,null);
 const scheduled=await rpc('claim_exam_fallback_run_health',['fallback:scheduled',100,request]);
 assert.equal((await state()).active_scheduler_request_id,request);
 await checkpoint(scheduled,'healthy',null,true,{},request);
 assert.equal((await one('SELECT health_outcome FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).health_outcome,'healthy');
});

test('scheduler treats 429 as temporary and configuration 4xx as neutral without reading response content',async()=>{
 let request=await rpc('dispatch_exam_fallback_scheduled_run');await response(request,429);
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);assert.equal((await state()).failure_count,1);
 await expireCooldown();request=await rpc('dispatch_exam_fallback_scheduled_run');await consume(request);await response(request,422);
 await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await state()).failure_count,1);
 assert.equal((await one('SELECT health_outcome FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).health_outcome,'neutral');
});

test('failed checkpoint is recovered from HTTP timeout; successful checkpoint is never counted again',async()=>{
 let request=await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await consume(request)).request_id,request);
 let run=await claim();
 // The worker times out before it can commit a checkpoint. pg_net is independent.
 await response(request,null,true,'synthetic timeout');
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);
 assert.equal((await state()).failure_count,1);
 await checkpoint(run,'transient_failure','fallback_backend_timeout',false,{},request);
 assert.equal((await state()).failure_count,1);
 await expireCooldown();request=await rpc('dispatch_exam_fallback_scheduled_run');await consume(request);run=await claim();
 await checkpoint(run,'healthy',null,false,{},request);await response(request,200);
 assert.equal((await state()).failure_count,0);
 await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await state()).failure_count,0);
});

test('HTTP200 without healthy checkpoint is neutral, not proof of a successful probe',async()=>{
 let run=await claim();await checkpoint(run,'transient_failure','fallback_backend_timeout',false);await expireCooldown();
 const request=await rpc('dispatch_exam_fallback_scheduled_run');await response(request,200);
 await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await state()).failure_count,1);
 assert.equal((await one('SELECT health_outcome FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).health_outcome,'neutral');
});

test('pending/absent pg_net response cannot accumulate triggers; stale responses cannot reset a recovered circuit',async()=>{
 const request=await rpc('dispatch_exam_fallback_scheduled_run');await consume(request);
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);
 await db.exec("UPDATE exam_fallback_scheduler_nonce SET expires_at=clock_timestamp()-interval '61 seconds'");
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);assert.equal((await state()).failure_count,1);
 await response(request,200);await expireCooldown();
 const next=await rpc('dispatch_exam_fallback_scheduled_run');assert(next && next!==request);
 assert.equal((await state()).failure_count,1);
 await consume(next);const run=await claim();await checkpoint(run,'healthy',null,true,{},next);
 await response(request,503);await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await state()).failure_count,0);
});

test('old nonce with reused request ID and old response cannot govern the current request',async()=>{
 const request=await rpc('dispatch_exam_fallback_scheduled_run');
 await db.query("INSERT INTO exam_fallback_scheduler_nonce(nonce_sha256,issued_epoch,expires_at,request_id,created_at) VALUES(repeat('f',64),1,clock_timestamp()-interval '2 hours',$1,clock_timestamp()-interval '2 hours')",[request]);
 await db.query("INSERT INTO net._http_response(id,status_code,created) VALUES($1,503,clock_timestamp()-interval '2 hours')",[request]);
 assert.equal(await rpc('dispatch_exam_fallback_scheduled_run'),null);assert.equal((await state()).failure_count,0);
 await response(request,503);await rpc('dispatch_exam_fallback_scheduled_run');assert.equal((await state()).failure_count,1);
 assert.equal((await one("SELECT health_observed_at FROM exam_fallback_scheduler_nonce WHERE nonce_sha256=repeat('f',64)")).health_observed_at,null);
});

test('legacy checkpoint remains compatible and circuit rollback preserves queues and active cron',async()=>{
 const run=await claim();const result=await rpc('checkpoint_exam_fallback_run',[run.run_token,'{}',false,'fallback_rpc_failed']);
 assert.equal(result.failure_count,1);
 await db.exec(await read('../operations/exam-fallback-backpressure-rollback.sql'));
 assert.equal((await claim()).claimed,true);
 assert.equal((await state()).failure_count,1);
 assert.equal((await one("SELECT active FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'")).active,true);
 assert.deepEqual(await one('SELECT * FROM clinical_preservation_fixture'),{id:1,queue_state:'pending',receipt:'unchanged'});
});

test('cleanup is bounded, indexed and runs during cooldown without touching the active request',async()=>{
 const request=await rpc('dispatch_exam_fallback_scheduled_run');await consume(request);const run=await claim();
 await db.exec("UPDATE exam_fallback_scheduler_nonce SET expires_at=clock_timestamp()-interval '2 days'");
 await db.exec("INSERT INTO exam_fallback_scheduler_nonce(nonce_sha256,issued_epoch,expires_at,health_observed_at,health_outcome) SELECT md5(n::text)||md5(n::text),1,clock_timestamp()-interval '2 days',clock_timestamp(),'neutral' FROM generate_series(1,1001) n");
 await rpc('dispatch_exam_fallback_scheduled_run');
 assert.equal(Number((await one('SELECT count(*) n FROM exam_fallback_scheduler_nonce')).n),2);
 assert.equal(Number((await one('SELECT count(*) n FROM exam_fallback_scheduler_nonce WHERE request_id=$1',[request])).n),1);
 assert.equal((await state()).run_token,run.run_token);
});
