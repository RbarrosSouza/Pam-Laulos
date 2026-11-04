import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), {PGlite}=require('@electric-sql/pglite');
const migration=await readFile(new URL('../migrations/20261104000045_exam_business_conflicts_no_retry.sql',import.meta.url),'utf8');
let db,beforeCatalog,beforeRows;
const rows=async sql=>(await db.query(sql)).rows;
const catalog=()=>rows("SELECT p.oid,p.proname,p.prosrc,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname");
before(async()=>{
 db=new PGlite();await db.exec(`
 CREATE ROLE fixture_owner NOLOGIN; CREATE ROLE fixture_caller NOLOGIN;
 CREATE TABLE public.fixture_rows(id integer PRIMARY KEY,value text NOT NULL);
 INSERT INTO public.fixture_rows VALUES(1,'must survive migration');
 CREATE FUNCTION public.business_conflict(reject boolean DEFAULT true) RETURNS integer
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $body$
 BEGIN
   IF reject THEN
     UPDATE public.fixture_rows SET value='must rollback' WHERE id=1;
     RAISE EXCEPTION 'lease expired' USING ERRCODE='40001';
   END IF;
   RETURN 7;
 END $body$;
 ALTER FUNCTION public.business_conflict(boolean) OWNER TO fixture_owner;
 GRANT SELECT,UPDATE ON public.fixture_rows TO fixture_owner;
 REVOKE ALL ON FUNCTION public.business_conflict(boolean) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION public.business_conflict(boolean) TO fixture_caller;
 CREATE FUNCTION public.direct_state() RETURNS void LANGUAGE plpgsql AS $body$
 BEGIN RAISE SQLSTATE '40001' USING MESSAGE='stale version'; END $body$;
 CREATE FUNCTION public.spaced_code() RETURNS void LANGUAGE plpgsql AS $body$
 BEGIN
   -- RAISE EXCEPTION 'comment' USING ERRCODE='40001';
   /* nested /* RAISE SQLSTATE '40001'; */ comment */
   rAiSe ExCePtIoN 'message with ; and RAISE SQLSTATE ''40001''' USING DETAIL='kept',
     eRrCoDe /* preserve comment */ = '40001';
 END $body$;
 CREATE FUNCTION public.native_handler() RETURNS text LANGUAGE plpgsql AS $body$
 BEGIN
   RETURN '40001 is still a native serialization code';
 EXCEPTION WHEN SQLSTATE '40001' THEN RETURN 'native recovery';
 END $body$;
 CREATE FUNCTION public.text_examples() RETURNS text LANGUAGE plpgsql AS $body$
 DECLARE example text:=$quoted$RAISE EXCEPTION 'example' USING ERRCODE='40001';$quoted$;
 BEGIN RETURN example || 'RAISE SQLSTATE ''40001'';'; END $body$;
 CREATE FUNCTION public.sql_example() RETURNS text LANGUAGE sql AS $body$
   SELECT 'RAISE SQLSTATE ''40001'';'
 $body$;
 CREATE FUNCTION public.stock_app_count() RETURNS void LANGUAGE plpgsql AS $body$
 BEGIN RAISE EXCEPTION 'Reload stale count' USING ERRCODE = '40001'; END $body$;
 `);
 beforeCatalog=await catalog();beforeRows=await rows('TABLE public.fixture_rows');
 await db.exec(migration);
});
after(async()=>{await db?.close();});
test('custom business rejection returns PT409 and retains mutation rollback and guards',async()=>{
 await assert.rejects(db.query('SELECT public.business_conflict()'),e=>e.code==='PT409'&&e.message==='lease expired');
 assert.deepEqual(await rows('TABLE public.fixture_rows'),beforeRows);
 assert.equal((await db.query('SELECT public.business_conflict(false) result')).rows[0].result,7);
 for(const name of ['direct_state','spaced_code','stock_app_count'])
  await assert.rejects(db.query('SELECT public.'+name+'()'),e=>e.code==='PT409');
});
test('owners, ACLs, settings, identity and untouched function definitions are preserved',async()=>{
 const after=await catalog();
 for(let i=0;i<beforeCatalog.length;i++) {
  const a=beforeCatalog[i],b=after[i];
  assert.equal(a.proname,b.proname);
  for(const k of ['oid','proowner','proacl','proconfig','prosecdef','provolatile'])assert.deepEqual(b[k],a[k],a.proname+':'+k);
  if(['native_handler','text_examples','sql_example'].includes(a.proname))assert.equal(b.definition,a.definition);
 }
 await db.exec('SET ROLE fixture_caller');
 assert.equal((await db.query('SELECT public.business_conflict(false) result')).rows[0].result,7);
 await db.exec('RESET ROLE');
});
test('comments, message strings and native error handlers are untouched',async()=>{
 const current=await catalog(),spaced=current.find(x=>x.proname==='spaced_code').prosrc;
 assert.match(spaced,/ERRCODE='40001';/);assert.match(spaced,/RAISE SQLSTATE ''40001''/);
 assert.match(spaced,/eRrCoDe \/\* preserve comment \*\/ = 'PT409'/);
 assert.match(current.find(x=>x.proname==='native_handler').prosrc,/WHEN SQLSTATE '40001'/);
 assert.equal((await db.query('SELECT public.sql_example() result')).rows[0].result,"RAISE SQLSTATE '40001';");
});
test('migration is idempotent and leaves no permanent helper or changed rows',async()=>{
 const prior=await catalog();await db.exec(migration);
 assert.deepEqual(await catalog(),prior);assert.deepEqual(await rows('TABLE public.fixture_rows'),beforeRows);
 assert.equal((await db.query("SELECT count(*) n FROM pg_proc WHERE proname='pam_nonretryable_business_conflicts'")).rows[0].n,0);
});
test('fresh migration handles 150k and 300k character UTF-8 function bodies within its timeout',async t=>{
 const fragment="-- ação 🐕: RAISE SQLSTATE '40001'; apenas comentário\nPERFORM length('texto çã RAISE EXCEPTION ''exemplo'' USING ERRCODE=''40001'';');\n";
 for(const target of [150000,300000]) {
  const name='large_utf8_'+target;
  const body='BEGIN\n'+fragment.repeat(Math.ceil(target/fragment.length))+"RAISE EXCEPTION 'large body conflict' USING ERRCODE='40001';\nEND";
  await db.exec(`CREATE FUNCTION public.${name}() RETURNS void LANGUAGE plpgsql AS $body$${body}$body$`);
  const original=(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[name+'()'])).rows[0].definition;
  const began=performance.now();await db.exec(migration);const elapsed=performance.now()-began;
  const current=(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[name+'()'])).rows[0].definition;
  assert.equal(current,original.replace("RAISE EXCEPTION 'large body conflict' USING ERRCODE='40001'","RAISE EXCEPTION 'large body conflict' USING ERRCODE='PT409'"));
  assert(elapsed<15000,`migration of ${body.length} UTF-8 characters took ${elapsed.toFixed(0)}ms`);
  t.diagnostic(`${body.length} characters / ${Buffer.byteLength(body)} bytes: ${elapsed.toFixed(0)}ms; exact body change verified`);
  await db.exec('DROP FUNCTION public.'+name+'()');
 }
});
