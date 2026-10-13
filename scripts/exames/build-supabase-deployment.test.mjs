import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildDeployment,writeDeployment,readReviewedSources,stripTransactionWrappers,deploymentCLIOptions,PROJECT_REF,LEGACY_RPC_VARIANT,LEGACY_RPC_MIGRATION} from './build-supabase-deployment.mjs';
const require=createRequire(import.meta.url),{PGlite}=require('@electric-sql/pglite');
const root=new URL('../../',import.meta.url);
const admin={userId:'10000000-0000-0000-0000-000000000011',email:'admin.fixture@example.invalid',identityVerified:true,roleAuthorized:'admin',verifiedAt:'2026-10-11T21:00:00.000Z',projectRef:'offline_fixture'};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function legacy(){
 const db=new PGlite();const fixture=await readFile(new URL('supabase/tests/collection-db.fixture.mjs',root),'utf8');
 const shared=fixture.match(/await db\.exec\(`([\s\S]*?)`\);/)[1];assert(!shared.includes('${'));
 await db.exec(shared);await db.exec('ALTER TABLE auth.users ADD COLUMN email text; CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);');
 await db.exec(await readFile(new URL('supabase-migration.sql',root),'utf8'));
 for(const file of ['20260324000001_bridge_tracking_to_card.sql','20260327000001_lab_shipment_and_history.sql','20260324000002_rpc_receive_email_result.sql','20260930000001_exams_in_group.sql'])await db.exec(await readFile(new URL('supabase/migrations/'+file,root),'utf8'));
 await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[admin.userId,admin.email]);
 await db.exec("SELECT set_config('pamvet.offline_fixture','true',false)");
 return db;
}
async function snapshot(db){
 const rows=[];const names=['clients','exam_card','exam_card_log','exam_item','exam_tracking','exames','lab_shipment','pets','v_exam_cards','veterinarios'];
 for(const name of names){
  const columns=(await db.query("SELECT a.attname name,t.typname type,CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END nullable FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=to_regclass('public.'||quote_ident($1)) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[name])).rows;
  rows.push({category:'columns',object_name:name,details:JSON.stringify(columns)});
  const relation=(await db.query("SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'kind',c.relkind::text,'acl',to_jsonb(c.relacl::text[]),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',to_jsonb(c.reloptions)) d FROM pg_class c WHERE c.oid=to_regclass('public.'||quote_ident($1))",[name])).rows[0].d;
  rows.push({category:'relation',object_name:name,details:JSON.stringify(relation)});
  for(const c of (await db.query("SELECT conname,pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid=to_regclass('public.'||quote_ident($1)) AND contype='c'",[name])).rows)rows.push({category:'constraint',object_name:name+':'+c.conname,details:c.d});
  for(const p of (await db.query("SELECT policyname,jsonb_build_object('cmd',cmd,'qual',qual,'roles',to_jsonb(roles::text[]),'permissive',permissive,'with_check',with_check) d FROM pg_policies WHERE schemaname='public' AND tablename=$1",[name])).rows)rows.push({category:'policy',object_name:name+':'+p.policyname,details:JSON.stringify(p.d)});
 }
 for(const f of (await db.query("SELECT p.oid::regprocedure::text sig,jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',to_jsonb(p.proacl::text[]),'definer',p.prosecdef,'search_path',to_jsonb(ARRAY(SELECT x FROM unnest(COALESCE(p.proconfig,'{}'::text[])) x WHERE split_part(x,'=',1)='search_path')),'md5',md5(pg_get_functiondef(p.oid))) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('bridge_tracking_to_card','delete_exam_cards','get_exam_card_summary','handle_exam_item_update','merge_exam_cards','move_exam_card','receive_email_result','set_exam_group_sent_at')")).rows)rows.push({category:'function',object_name:f.sig,details:JSON.stringify(f.d)});
 rows.push({category:'registry',object_name:'migration_table',details:'supabase_migrations.schema_migrations'});return rows;
}
async function fixtureDefinitions(db){return [{category:'registry_columns',object_name:'supabase_migrations.schema_migrations',definition:JSON.stringify((await db.query("SELECT a.attname name,t.typname type,CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END nullable FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid='supabase_migrations.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum")).rows)},{category:'view',object_name:'v_exam_cards',definition:(await db.query("SELECT pg_get_viewdef('public.v_exam_cards'::regclass,true) d")).rows[0].d}]}
async function guardedFixture(db,patch={}){return buildDeployment({mode:'synthetic_fixture',verifiedAdmin:admin,catalogRows:await snapshot(db),definitionsRows:await fixtureDefinitions(db),...patch})}
async function noPipeline(db){const row=(await db.query("SELECT to_regclass('public.exam_document') new_table,(SELECT count(*) FROM supabase_migrations.schema_migrations) registry_count")).rows[0];assert.equal(row.new_table,null);assert.equal(Number(row.registry_count),0)}

 test('only paired top/final transaction wrappers are removed; function bodies and reviewed hashes remain unchanged',async()=>{
  const sources=await readReviewedSources();assert.deepEqual(sources.map(s=>s.removedBegin),[true,true,false,true]);assert.deepEqual(sources.map(s=>s.removedCommit),[true,true,false,true]);
  assert(sources.every(s=>s.body.includes('CREATE')));assert(sources[0].body.includes('BEGIN\n'));assert(!sources[0].body.endsWith('COMMIT;\n'));
  assert.deepEqual(stripTransactionWrappers('-- c\nCREATE FUNCTION x() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql;\n'),{body:'-- c\nCREATE FUNCTION x() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql;\n',removedBegin:false,removedCommit:false});
  assert.throws(()=>stripTransactionWrappers('BEGIN;\nSELECT 1;\n'),/unpaired/);
  for(const source of sources)assert.equal(sha(source.source),source.sha256);
 });
 test('default real-catalog artifact is a fail-closed template with no invented admin',async()=>{
  const result=await buildDeployment();assert.equal(result.manifest.mode,'template');assert.equal(result.manifest.readyToApply,false);assert.equal(result.manifest.adminIdentityIncluded,false);assert.equal(result.manifest.catalogRowCount,55);
  assert(result.sql.indexOf('TEMPLATE SEM ADMINISTRADOR')<result.sql.indexOf('CREATE TABLE public.exam_document_member'));assert(!result.sql.includes(admin.userId));
  const db=await legacy();try{await assert.rejects(db.exec(result.sql),/TEMPLATE SEM ADMINISTRADOR/);await db.exec('ROLLBACK');await noPipeline(db)}finally{await db.close()}
 });
 test('verified mode refuses missing identity/role/project evidence and rejects unsafe or inconsistent values',async()=>{
  for(const verifiedAdmin of [undefined,{...admin,identityVerified:false},{...admin,roleAuthorized:'vet'},{...admin,projectRef:'another-project'},{...admin,userId:'not-uuid'},{...admin,email:'x@example.invalid;DROP TABLE auth.users;'}, {...admin,verifiedAt:'invalid'}])await assert.rejects(buildDeployment({mode:'verified_admin',verifiedAdmin}));
 });
 test('administrative review includes proposed identity/seed but always aborts before auth lookup, locks or DDL and rolls back its transaction',async()=>{
  const verifiedAdmin={...admin,projectRef:PROJECT_REF},beforeSources=await readReviewedSources();
  const {sql,manifest}=await buildDeployment({mode:'administrative_review',verifiedAdmin});
  assert.equal(manifest.mode,'administrative_review');assert.equal(manifest.readyToApply,false);assert.equal(manifest.requiresSeparateApproval,true);
  assert.equal(manifest.adminIdentityIncluded,true);assert.equal(manifest.reviewOnly,true);assert.equal(manifest.applicationBlocked,true);assert.equal(manifest.requiresFinalBrowserConfirmation,true);
  assert(sql.includes('PROPOSED SEED ONLY'));assert(sql.includes("SELECT id,'admin',true FROM auth.users WHERE id='"+admin.userId+"'::uuid AND email='"+admin.email+"'"));
  const refusal=sql.indexOf('REVISÃO ADMINISTRATIVA — NÃO APLICAR');assert(refusal>0);
  for(const later of ['PERFORM 1 FROM auth.users','pg_advisory_xact_lock','LOCK TABLE','CREATE TABLE public.exam_document_member','INSERT INTO public.exam_document_member'])assert(refusal<sql.indexOf(later),later);
  const db=await legacy();try{
   await db.exec('CREATE TABLE public.review_transaction_probe(n integer)');
   const before=await snapshot(db),beforeView=(await db.query("SELECT pg_get_viewdef('public.v_exam_cards'::regclass,true) d")).rows[0].d;
   const beforeUsers=(await db.query('SELECT id,email FROM auth.users ORDER BY id')).rows,beforeBuckets=(await db.query('SELECT id,name,public FROM storage.buckets ORDER BY id')).rows;
   await assert.rejects(db.exec(sql),/REVISÃO ADMINISTRATIVA — NÃO APLICAR/);
   await assert.rejects(db.query('SELECT 1'),/current transaction is aborted/);await db.exec('ROLLBACK');
   await noPipeline(db);assert.deepEqual(await snapshot(db),before);
   assert.equal((await db.query("SELECT pg_get_viewdef('public.v_exam_cards'::regclass,true) d")).rows[0].d,beforeView);
   assert.deepEqual((await db.query('SELECT id,email FROM auth.users ORDER BY id')).rows,beforeUsers);assert.deepEqual((await db.query('SELECT id,name,public FROM storage.buckets ORDER BY id')).rows,beforeBuckets);
   // Test-only probe proves writes in the outer transaction cannot escape review refusal.
   const instrumented=sql.replace('BEGIN;\n','BEGIN;\nINSERT INTO public.review_transaction_probe VALUES(1);\n');
   await assert.rejects(db.exec(instrumented),/REVISÃO ADMINISTRATIVA — NÃO APLICAR/);await db.exec('ROLLBACK');
   assert.equal(Number((await db.query('SELECT count(*) n FROM public.review_transaction_probe')).rows[0].n),0);await noPipeline(db);
   // Refusal is unconditional even when the proposed Auth identity is no longer present.
   await db.query('DELETE FROM auth.users WHERE id=$1',[admin.userId]);
   await assert.rejects(db.exec(sql),/REVISÃO ADMINISTRATIVA — NÃO APLICAR/);await db.exec('ROLLBACK');await noPipeline(db);
  }finally{await db.close()}
  assert.deepEqual((await readReviewedSources()).map(s=>s.sha256),beforeSources.map(s=>s.sha256));
 });
 test('administrative review requires the same verified identity evidence and records requested role without granting it',async()=>{
  const valid={...admin,projectRef:PROJECT_REF};
  for(const verifiedAdmin of [undefined,{...valid,identityVerified:false},{...valid,roleAuthorized:'vet'},{...valid,projectRef:'another-project'},{...valid,userId:'invalid'},{...valid,email:'invalid'},{...valid,verifiedAt:'invalid'}])await assert.rejects(buildDeployment({mode:'administrative_review',verifiedAdmin}));
  const {manifest}=await buildDeployment({mode:'administrative_review',verifiedAdmin:valid});assert(manifest.limitations.some(x=>x.includes('requested role, not an executed grant')));assert.equal(manifest.readyToApply,false);
 });
 test('review CLI has its own flag and writes distinct private non-applicable artifacts without changing legacy CLI modes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'pamvet-admin-review-'));
  try{
   const evidence=path.join(directory,'evidence.fixture.json'),verifiedAdmin={...admin,projectRef:PROJECT_REF};await writeFile(evidence,JSON.stringify(verifiedAdmin),{mode:0o600});
   const options=await deploymentCLIOptions(['--admin-review-json',evidence]);assert.equal(options.mode,'administrative_review');assert.deepEqual(options.verifiedAdmin,verifiedAdmin);
   assert.deepEqual(await deploymentCLIOptions([]),{});assert.equal((await deploymentCLIOptions(['--verified-admin-json',evidence])).mode,'verified_admin');
   for(const args of [['--admin-review-json'],['--unknown',evidence],['--admin-review-json',evidence,'--extra']])await assert.rejects(deploymentCLIOptions(args),/usage_template/);
   const result=await writeDeployment({...options,outputDir:directory});assert.equal(path.basename(result.sqlPath),'SUPABASE-EXAMES-01-04-revisao-administrativa-nao-aplicar.sql');assert.equal(result.readyToApply,false);
   assert.equal((await stat(result.sqlPath)).mode&0o777,0o600);assert.equal((await stat(result.manifestPath)).mode&0o777,0o600);
   const written=JSON.parse(await readFile(result.manifestPath,'utf8'));assert.equal(written.applicationBlocked,true);assert.equal(written.requiresSeparateApproval,true);assert.equal(written.requiresFinalBrowserConfirmation,true);
   assert((await readFile(result.sqlPath,'utf8')).includes('REVISÃO ADMINISTRATIVA — NÃO APLICAR'));
  }finally{await rm(directory,{recursive:true,force:true})}
 });
 test('synthetic transaction installs sources01→04, seeds only exact existing admin, preserves paused destinations and writes real source registry',async()=>{
  const db=await legacy();try{
   const {sql,manifest}=await guardedFixture(db);assert.equal(manifest.readyToApply,false);await db.exec(sql);
   const members=(await db.query('SELECT user_id,role,active FROM exam_document_member')).rows;assert.equal(members.length,1);assert.equal(members[0].user_id,admin.userId);assert.equal(members[0].role,'admin');assert.equal(members[0].active,true);
   const cfg=(await db.query('SELECT enabled_destinations,notification_cutoff,group_destination_key FROM exam_document_configuration')).rows[0];assert.deepEqual(cfg.enabled_destinations,[]);assert.equal(cfg.notification_cutoff,null);assert.equal(cfg.group_destination_key,null);
   const registry=(await db.query('SELECT version,statements FROM supabase_migrations.schema_migrations ORDER BY version')).rows;assert.equal(registry.length,4);assert.deepEqual(registry.map(r=>r.version),manifest.migrations.map(m=>m.version));
   for(let i=0;i<4;i++)assert.equal(sha(registry[i].statements[0]),manifest.migrations[i].sha256);
   for(const table of ['exam_document','exam_document_source','exam_document_item','exam_document_delivery','exam_document_event','exam_collection_cursor'])assert.equal(Number((await db.query('SELECT count(*) n FROM '+table)).rows[0].n),0);
   await assert.rejects(db.exec(sql),/Registro das migrations colide/);await db.exec('ROLLBACK');assert.equal(Number((await db.query('SELECT count(*) n FROM exam_document_member')).rows[0].n),1);
  }finally{await db.close()}
 });
 test('absent or mismatched administrator aborts before schema/policy changes',async()=>{
  for(const change of ['absent','email']){const db=await legacy();try{
   const before=await snapshot(db),{sql}=await buildDeployment({mode:'synthetic_fixture',verifiedAdmin:admin,catalogRows:before,definitionsRows:await fixtureDefinitions(db)});
   await db.query(change==='absent'?'DELETE FROM auth.users WHERE id=$1':'UPDATE auth.users SET email=$2 WHERE id=$1',[admin.userId,...(change==='email'?['changed@example.invalid']:[])]);
   await assert.rejects(db.exec(sql),/Administrador verificado ausente/);await db.exec('ROLLBACK');await noPipeline(db);assert.deepEqual(await snapshot(db),before);
  }finally{await db.close()}}
 });
 test('new schema/RPC/bucket/column/registry collisions never overwrite existing objects',async()=>{
  const mutations=["CREATE TABLE public.exam_document_collision(id int)","CREATE FUNCTION public.reserve_exam_document_collision() RETURNS void LANGUAGE sql AS $$ SELECT $$", "INSERT INTO storage.buckets(id,name,public) VALUES('exam_documents_private','fixture',true)","ALTER TABLE exames ADD COLUMN storage_path text", "INSERT INTO supabase_migrations.schema_migrations(version) VALUES('20261010000003')"];
  for(const mutation of mutations){const db=await legacy();try{const {sql}=await guardedFixture(db);await db.exec(mutation);await assert.rejects(db.exec(sql),/colide|colid|já existe/);await db.exec('ROLLBACK');assert.equal((await db.query("SELECT to_regclass('public.exam_document') t")).rows[0].t,null)}finally{await db.close()}}
 });
 test('legacy column/ACL/RPC/policy drift invalidates the catalog before any new DDL',async()=>{
  const mutations=["ALTER TABLE clients ADD COLUMN fixture_new text","ALTER TABLE exam_card DISABLE ROW LEVEL SECURITY","REVOKE ALL ON exam_item FROM service_role","ALTER FUNCTION bridge_tracking_to_card() SET search_path=pg_catalog","CREATE POLICY fixture_unreviewed ON exam_card FOR SELECT USING(true)"];
  for(const mutation of mutations){const db=await legacy();try{const {sql}=await guardedFixture(db);await db.exec(mutation);await assert.rejects(db.exec(sql),/diverg|mudou/);await db.exec('ROLLBACK');await noPipeline(db)}finally{await db.close()}}
 });
 test('a late failure after all DDL/seed rolls back everything; no earlier source COMMIT escaped',async()=>{
  const db=await legacy();try{
   const {sql}=await guardedFixture(db),late=sql.replace(/COMMIT;\n$/,()=>"DO $$ BEGIN RAISE EXCEPTION 'synthetic_late_failure'; END $$;\nCOMMIT;\n");
   await assert.rejects(db.exec(late),/synthetic_late_failure/);await db.exec('ROLLBACK');await noPipeline(db);
   assert.equal((await db.query("SELECT to_regclass('public.exam_document_member') t")).rows[0].t,null);
  }finally{await db.close()}
 });
 test('private output is0600, deterministic by inputs, writes no temporary debris and never changes source fingerprints',async()=>{
  const before=await readReviewedSources(),directory=await mkdtemp(path.join(tmpdir(),'pamvet-deployment-package-'));
  try{const result=await writeDeployment({outputDir:directory});assert.equal((await stat(result.sqlPath)).mode&0o777,0o600);assert.equal((await stat(result.manifestPath)).mode&0o777,0o600);const second=await writeDeployment({outputDir:directory});assert.equal(second.sqlSha256,result.sqlSha256);assert.deepEqual((await readReviewedSources()).map(s=>s.sha256),before.map(s=>s.sha256))}finally{await rm(directory,{recursive:true,force:true})}
 });
 test('review checksum mismatch is refused rather than repackaged',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'pamvet-deployment-review-'));try{
   const reviewed=await readFile(new URL('docs/exames/revisao-implantacao-supabase-2026-10-11.md',root),'utf8');const p=path.join(directory,'review.md');await writeFile(p,reviewed.replace(/\| 01 \| `[a-f0-9]{64}`/,'| 01 | `'+'f'.repeat(64)+'`'));
   await assert.rejects(readReviewedSources({reviewPath:p}),/fingerprint_mismatch/);
  }finally{await rm(directory,{recursive:true,force:true})}
 });

 const rpc="public.receive_email_result(text,text,text,text,text,timestamp with time zone)";
 async function legacyAcl(db){return (await db.query("SELECT pg_get_userbyid(p.proowner) owner,p.prosecdef definer,md5(pg_get_functiondef(p.oid)) md5,COALESCE(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable),'[]'::jsonb) acl FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure GROUP BY p.oid",[rpc])).rows[0]}
 async function transitionFixture(db,patch={}){await db.exec('GRANT EXECUTE ON FUNCTION '+rpc+' TO anon,authenticated,service_role');return guardedFixture(db,{variant:LEGACY_RPC_VARIANT,...patch})}
 function beforeFifth(sql,instrumentation){const marker='\n-- SOURCE '+LEGACY_RPC_MIGRATION;assert(sql.includes(marker));return sql.replace(marker,()=>'\n'+instrumentation+'\n'+marker)}

 test('optional fifth source restores exact legacy ACL/body and preserves old RPC while unconditionally blocking all document INSERT',async()=>{
  const db=await legacy();try{
   const {sql,manifest}=await transitionFixture(db),before=await legacyAcl(db);await db.exec(sql);
   assert.equal(manifest.migrations.length,5);assert.equal(manifest.supabaseRegistryRowsPlanned,5);assert.equal(manifest.documentIngestionBlocked,true);assert.equal(manifest.retirementImplemented,false);
   assert.deepEqual(await legacyAcl(db),before);
   const rows=(await db.query('SELECT version,statements FROM supabase_migrations.schema_migrations ORDER BY version')).rows;assert.equal(rows.length,5);for(let i=0;i<rows.length;i++)assert.equal(sha(rows[i].statements[0]),manifest.migrations[i].sha256);
   for(const role of ['anon','authenticated','service_role']){
    await db.exec('SET ROLE '+role);
    const {rows}=await db.query("SELECT public.receive_email_result(p_pet_name=>$1,p_client_name=>$2,p_exam_type=>$3,p_lab_name=>$4) result",['Synthetic '+role,'Tutor fixture','Exam fixture','Lab fixture']);assert.equal(rows[0].result.success,true);assert(rows[0].result.card_id);
    if(role==='anon')await assert.rejects(db.query('SELECT * FROM public.exam_document'),/permission denied|row-level/);
    if(role==='authenticated')assert.deepEqual((await db.query('SELECT * FROM public.exam_document')).rows,[]);
    if(role!=='service_role')await assert.rejects(db.exec("INSERT INTO public.exam_card(status,origin) VALUES('exame_pronto','email')"),/permission denied|row-level/);
    await db.exec('RESET ROLE');
   }
   assert.equal(Number((await db.query('SELECT count(*) n FROM public.exam_card')).rows[0].n),3);assert.equal(Number((await db.query('SELECT count(*) n FROM public.exam_document')).rows[0].n),0);
   for(const role of ['postgres','service_role']){await db.exec('SET ROLE '+role);await assert.rejects(db.exec('INSERT INTO public.exam_document DEFAULT VALUES'),/Fase administrativa: criação de documentos bloqueada/);await db.exec('RESET ROLE')}
   const trigger=(await db.query("SELECT tgenabled FROM pg_trigger WHERE tgname='guard_exam_document_admin_phase_insert' AND tgrelid='public.exam_document'::regclass")).rows[0];assert.equal(trigger.tgenabled,'A');
   assert.equal((await db.query("SELECT has_function_privilege('anon','public.guard_exam_document_admin_phase_insert()','EXECUTE') allowed")).rows[0].allowed,false);
   // Test-only future ACL hardening is not a retirement migration and cannot unlock.
   await db.exec('REVOKE ALL ON FUNCTION '+rpc+' FROM PUBLIC,anon,authenticated');
   for(const role of ['postgres','service_role']){await db.exec('SET ROLE '+role);await assert.rejects(db.exec('INSERT INTO public.exam_document DEFAULT VALUES'),/Fase administrativa: criação de documentos bloqueada/);await db.exec('RESET ROLE')}
   await db.exec("SET session_replication_role='replica'");await assert.rejects(db.exec('INSERT INTO public.exam_document DEFAULT VALUES'),/Fase administrativa: criação de documentos bloqueada/);await db.exec("SET session_replication_role='origin'");
   assert.equal(Number((await db.query('SELECT count(*) n FROM public.exam_document')).rows[0].n),0);
  }finally{await db.close()}
 });
 test('fifth source rejects changed overloads, body attributes, owner or post02 ACL and fully rolls back',async()=>{
  const changes=["CREATE FUNCTION public.receive_email_result(text) RETURNS json LANGUAGE sql AS $$ SELECT '{}'::json $$;",'ALTER FUNCTION '+rpc+' SECURITY INVOKER;','ALTER FUNCTION '+rpc+' OWNER TO service_role;','GRANT EXECUTE ON FUNCTION '+rpc+' TO anon;'];
  for(const change of changes){const db=await legacy();try{
   const {sql}=await transitionFixture(db),before=await snapshot(db),beforeRpc=await legacyAcl(db);
   await assert.rejects(db.exec(beforeFifth(sql,change)),/Inventário|Corpo|ACL após/);await db.exec('ROLLBACK');await noPipeline(db);assert.deepEqual(await snapshot(db),before);assert.deepEqual(await legacyAcl(db),beforeRpc);
  }finally{await db.close()}}
 });
 test('fifth source rejects non-reproducible grant options and outer transaction rolls back restored ACL/barrier on late failure',async()=>{
  const invalid=await legacy();try{
   await invalid.exec('GRANT EXECUTE ON FUNCTION '+rpc+' TO anon WITH GRANT OPTION');const {sql}=await transitionFixture(invalid);
   await assert.rejects(invalid.exec(sql),/Grantor ou grant option/);await invalid.exec('ROLLBACK');await noPipeline(invalid);
  }finally{await invalid.close()}
  const db=await legacy();try{
   const {sql}=await transitionFixture(db),before=await snapshot(db),beforeRpc=await legacyAcl(db);
   const late=sql.replace(/COMMIT;\n$/,()=>"DO $$ BEGIN RAISE EXCEPTION 'synthetic_fifth_late_failure'; END $$;\nCOMMIT;\n");await assert.rejects(db.exec(late),/synthetic_fifth_late_failure/);await db.exec('ROLLBACK');await noPipeline(db);assert.deepEqual(await snapshot(db),before);assert.deepEqual(await legacyAcl(db),beforeRpc);
   assert.equal((await db.query("SELECT to_regprocedure('public.guard_exam_document_admin_phase_insert()') f")).rows[0].f,null);
  }finally{await db.close()}
 });
 test('optional administrative review remains non-applicable, has five audited sources and distinct0600 CLI outputs; historical4 artifact remains untouched',async()=>{
  const standard=await buildDeployment();assert.equal(sha(await readFile(new URL('../n8n-verificado-2026-10-11/SUPABASE-EXAMES-01-04-template-nao-aplicar.sql',root))),'20add6f265f3a104bd9ecd0d75b6b81494d5cdd89b5e07d446e1bf409c14c0fd');assert.equal(standard.manifest.migrations.length,4);assert(standard.sql.includes('SET LOCAL search_path=pg_catalog,public;'));
  const directory=await mkdtemp(path.join(tmpdir(),'pamvet-fifth-review-'));try{
   const evidence=path.join(directory,'evidence.fixture.json'),verifiedAdmin={...admin,projectRef:PROJECT_REF};await writeFile(evidence,JSON.stringify(verifiedAdmin),{mode:0o600});
   const options=await deploymentCLIOptions(['--admin-review-json',evidence,'--preserve-legacy-rpc']);assert.equal(options.variant,LEGACY_RPC_VARIANT);
   const result=await writeDeployment({...options,outputDir:directory});assert.equal(result.readyToApply,false);assert.equal(result.applicationBlocked,true);assert.equal(result.documentIngestionBlocked,true);assert.equal(result.supabaseRegistryRowsPlanned,5);assert.equal(path.basename(result.sqlPath),'SUPABASE-EXAMES-01-05-legado-preservado-revisao-administrativa-nao-aplicar.sql');
   assert.equal((await stat(result.sqlPath)).mode&0o777,0o600);assert.equal((await stat(result.manifestPath)).mode&0o777,0o600);
   const sql=await readFile(result.sqlPath,'utf8'),db=await legacy();try{await assert.rejects(db.exec(sql),/REVISÃO ADMINISTRATIVA — NÃO APLICAR/);await db.exec('ROLLBACK');await noPipeline(db)}finally{await db.close()}
   const five=await readReviewedSources({variant:LEGACY_RPC_VARIANT});assert.equal(five.length,5);assert.deepEqual(five.slice(0,4).map(x=>x.sha256),standard.manifest.migrations.map(x=>x.sha256));
  }finally{await rm(directory,{recursive:true,force:true})}
 });
