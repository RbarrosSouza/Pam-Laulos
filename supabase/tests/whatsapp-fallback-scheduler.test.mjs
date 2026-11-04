import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {PGlite}=require('@electric-sql/pglite');
const sql=await readFile(new URL('../operations/exam-whatsapp-fallback-scheduler.sql',import.meta.url),'utf8');
let db;
const one=async(text,args=[]) => (await db.query(text,args)).rows[0];
const scalar=async(text,args=[]) => (await one(text,args)).result;
// pg_cron/pg_net/Vault/pgcrypto are external extensions unavailable in PGlite.
// Stubs model their SQL interfaces and record calls, not HTTP or encryption.
// Real HMAC verification has independent Node/WebCrypto tests in auth.test.mjs.
before(async()=>{
 db=new PGlite();await db.exec(`
 CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
 CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA vault; CREATE SCHEMA cron; CREATE SCHEMA net;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
 CREATE FUNCTION public.require_exam_document_service() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service required' USING ERRCODE='42501'; END IF; END$$;
 CREATE TABLE public.exam_fallback_configuration(singleton boolean PRIMARY KEY DEFAULT true,enabled boolean DEFAULT false,source_account_id text,source_conversation_id text,received_from timestamptz);
 INSERT INTO public.exam_fallback_configuration(singleton) VALUES(true);
 CREATE TABLE public.exam_document_configuration(singleton boolean PRIMARY KEY DEFAULT true,ingestion_enabled boolean DEFAULT true,enabled_destinations text[] DEFAULT ARRAY['group'],notification_cutoff timestamptz DEFAULT now(),group_destination_key text DEFAULT 'synthetic-group');
 INSERT INTO public.exam_document_configuration(singleton) VALUES(true);
 CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
 CREATE TABLE extensions.calls(data bytea,key bytea,kind text);
 CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql AS $$SELECT decode(md5($1)||md5($1),'hex')$$;
 CREATE FUNCTION extensions.hmac(bytea,bytea,text) RETURNS bytea LANGUAGE plpgsql AS $$BEGIN INSERT INTO extensions.calls VALUES($1,$2,$3); RETURN decode(repeat('ab',32),'hex'); END$$;
 CREATE TABLE net.http_request_queue(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,body jsonb,headers jsonb,timeout_milliseconds int);
 CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}',params jsonb DEFAULT '{}',headers jsonb DEFAULT '{}',timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$INSERT INTO net.http_request_queue(url,body,headers,timeout_milliseconds) VALUES($1,$2,$4,$5) RETURNING id$$;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text,username text DEFAULT current_user,database text DEFAULT current_database(),command text,schedule text,active boolean DEFAULT true,UNIQUE(jobname,username));
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) ON CONFLICT(jobname,username) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command RETURNING jobid$$;
 CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET schedule=coalesce($2,cron.job.schedule),active=coalesce($6,cron.job.active) WHERE jobid=$1$$;
 INSERT INTO cron.job(jobname,command,schedule) VALUES('other-existing-job','SELECT 1;','0 * * * *');
 `);
 await db.exec(sql);
});
after(async()=>{await db?.close();});
test('install and repeat install leave exactly one inactive job and no credentials or outbound request',async()=>{
 await db.exec(sql);
 assert.equal(Number((await one("SELECT count(*) n FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'")).n),1);
 assert.equal((await one("SELECT active FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'")).active,false);
 assert.equal((await one('SELECT enabled FROM exam_fallback_configuration')).enabled,false);
 assert.equal(Number((await one('SELECT count(*) n FROM vault.decrypted_secrets')).n),0);
 assert.equal(await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'),null);
 await assert.rejects(scalar('SELECT public.set_exam_fallback_schedule(true) result'),/secrets invalid/);
 for(const role of ['anon','authenticated']) {
  await db.exec('SET ROLE '+role);
  await assert.rejects(scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'),e=>e.code==='42501');
  await assert.rejects(db.query('SELECT * FROM public.exam_fallback_scheduler_nonce'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
 }
});
test('activation validates scope and sends signature without putting long-lived key into pg_net',async()=>{
 await db.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',['exam_whatsapp_fallback_trigger_key','synthetic-scheduler-test-key-never-used-in-production']);
 await assert.rejects(scalar('SELECT public.set_exam_fallback_schedule(true) result'),/source scope incomplete/);
 await db.exec("UPDATE exam_fallback_configuration SET source_account_id='chatwoot:1:inbox:2',source_conversation_id='3',received_from=now()-interval '1 hour'");
 assert.equal((await scalar('SELECT public.set_exam_fallback_schedule(true) result')).enabled,true);
 const id=await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result');assert(id);
 const queued=await one('SELECT *,body::text body_text FROM net.http_request_queue WHERE id=$1',[id]);
 assert.equal(queued.url,'https://jvgquuahsxepphhxmshk.supabase.co/functions/v1/exam-whatsapp-fallback');
 assert.deepEqual(queued.body,{action:'run'});assert.equal(queued.headers.Authorization,undefined);
 assert(!JSON.stringify(queued).includes('synthetic-scheduler-test-key'));
 assert.equal((await one("SELECT convert_from(data,'UTF8') data FROM extensions.calls LIMIT 1")).data,
  queued.headers['x-exam-fallback-timestamp']+'\n'+queued.headers['x-exam-fallback-nonce']+'\n'+queued.body_text);
 assert.equal(await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'),null);
});
test('nonce is consumed once atomically; wrong identity, timestamp, expired and disabled calls fail closed',async()=>{
 const queued=await one('SELECT * FROM net.http_request_queue ORDER BY id DESC LIMIT 1');
 const nonce=queued.headers['x-exam-fallback-nonce'],timestamp=Number(queued.headers['x-exam-fallback-timestamp']);
 await db.exec("SELECT set_config('request.jwt.claim.role','service_role',false); SET ROLE service_role");
 const consume=(id,stamp)=>scalar('SELECT public.consume_exam_fallback_scheduler_trigger($1,$2) result',[id,stamp]);
 assert.equal((await consume(crypto.randomUUID(),timestamp)).accepted,false);
 assert.equal((await consume(nonce,timestamp-1)).accepted,false);
 assert.equal((await consume(nonce,timestamp)).accepted,true);
 assert.equal((await consume(nonce,timestamp)).accepted,false);
 await db.exec('RESET ROLE');
 assert(await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'));
 const next=await one('SELECT * FROM net.http_request_queue ORDER BY id DESC LIMIT 1');
 await db.exec("UPDATE exam_fallback_scheduler_nonce SET expires_at=now()-interval '1 second' WHERE consumed_at IS NULL");
 assert.equal((await consume(next.headers['x-exam-fallback-nonce'],Number(next.headers['x-exam-fallback-timestamp']))).accepted,false);
 assert(await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'));
 await scalar('SELECT public.set_exam_fallback_schedule(false) result');
 const last=await one('SELECT * FROM net.http_request_queue ORDER BY id DESC LIMIT 1');
 assert.equal((await consume(last.headers['x-exam-fallback-nonce'],Number(last.headers['x-exam-fallback-timestamp']))).accepted,false);
 assert.equal(await scalar('SELECT public.dispatch_exam_fallback_scheduled_run() result'),null);
 assert.deepEqual(await one("SELECT active,schedule,command FROM cron.job WHERE jobname='other-existing-job'"),{active:true,schedule:'0 * * * *',command:'SELECT 1;'});
});
test('an unexpected endpoint or colliding job fails instead of exfiltrating or modifying other work',async()=>{
 await db.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',['exam_whatsapp_fallback_project_url','https://attacker.invalid']);
 await assert.rejects(scalar('SELECT public.set_exam_fallback_schedule(true) result'),/secrets invalid/);
 await db.exec("UPDATE cron.job SET command='SELECT 2;' WHERE jobname='exam-whatsapp-fallback-minute'");
 await assert.rejects(db.exec(sql),/job name collision/);await db.exec('ROLLBACK');
 assert.equal((await one("SELECT command FROM cron.job WHERE jobname='exam-whatsapp-fallback-minute'")).command,'SELECT 2;');
});
