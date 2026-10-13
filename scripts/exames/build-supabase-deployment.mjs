// Builds private SQL only. No database client, network, process.env, secrets or deploy.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const appRoot=fileURLToPath(new URL('../../',import.meta.url));
export const PROJECT_REF='jvgquuahsxepphhxmshk';
export const MIGRATIONS=Object.freeze([
 '20261010000001_exam_documents.sql','20261010000002_exam_document_card_guards.sql',
 '20261010000003_exam_document_staging_journal.sql','20261010000004_exam_collection_checkpoint.sql',
]);
export const LEGACY_RPC_VARIANT='legacy_rpc_admin_transition';
export const LEGACY_RPC_MIGRATION='20261012000005_exam_legacy_rpc_admin_transition.sql';
const legacySignature='receive_email_result(text,text,text,text,text,timestamp with time zone)';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(ok,code)=>{if(!ok)throw new Error(code)};
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const allowedCategories=new Set(['columns','constraint','function','policy','registry','relation']);
export function stripTransactionWrappers(source){
 let body=source,removedBegin=false,removedCommit=false;
 const start=body.match(/^((?:\s|--[^\n]*(?:\n|$))*)BEGIN;[\t ]*\r?\n/);
 if(start){body=start[1]+body.slice(start[0].length);removedBegin=true;}
 const end=body.match(/\r?\nCOMMIT;[\t ]*(?:\r?\n)?$/);
 if(end){body=body.slice(0,end.index)+(end[0].endsWith('\n')?'\n':'');removedCommit=true;}
 check(removedBegin===removedCommit,'migration_transaction_wrappers_unpaired');
 return {body,removedBegin,removedCommit};
}
function adminInput(mode,identity){
 if(mode==='template'){check(identity===undefined,'template_admin_not_allowed');return null;}
 check(mode==='verified_admin'||mode==='administrative_review'||mode==='synthetic_fixture','deployment_mode_invalid');
 check(object(identity)&&Object.keys(identity).every(k=>['userId','email','identityVerified','roleAuthorized','verifiedAt','projectRef'].includes(k)),'verified_admin_fields_invalid');
 check(identity.identityVerified===true&&identity.roleAuthorized==='admin','verified_admin_required');
 check(typeof identity.userId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.userId),'verified_admin_uuid_invalid');
 check(typeof identity.email==='string'&&identity.email.length<=320&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(identity.email)&&identity.email.includes('.')&&!identity.email.includes('..'),'verified_admin_email_invalid');
 check(typeof identity.verifiedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(identity.verifiedAt)&&Number.isFinite(Date.parse(identity.verifiedAt)),'verified_admin_evidence_timestamp_invalid');
 check(identity.projectRef===(mode==='synthetic_fixture'?'offline_fixture':PROJECT_REF),'verified_admin_project_mismatch');
 return {...identity,userId:identity.userId.toLowerCase()};
}
function catalog(rows,mode){
 check(Array.isArray(rows)&&rows.length>0&&(mode==='synthetic_fixture'||rows.length===55),'deployment_catalog_invalid');
 const keys=new Set();
 for(const row of rows){
  check(object(row)&&Object.keys(row).every(k=>['category','object_name','details'].includes(k))&&allowedCategories.has(row.category)&&typeof row.object_name==='string'&&typeof row.details==='string','deployment_catalog_row_invalid');
  const key=JSON.stringify([row.category,row.object_name]);check(!keys.has(key),'deployment_catalog_duplicate');keys.add(key);
  if(row.category!=='constraint'&&row.category!=='registry')JSON.parse(row.details);
 }
 check(rows.some(r=>r.category==='registry'&&r.details==='supabase_migrations.schema_migrations'),'deployment_registry_snapshot_required');
 return rows;
}
export async function readReviewedSources({root=appRoot,reviewPath=path.join(root,'docs/exames/revisao-implantacao-supabase-2026-10-11.md'),variant='standard'}={}){
 check(variant==='standard'||variant===LEGACY_RPC_VARIANT,'deployment_variant_invalid');
 const reviewed=await fs.readFile(reviewPath,'utf8'),sources=[];
 const selected=variant===LEGACY_RPC_VARIANT?[...MIGRATIONS,LEGACY_RPC_MIGRATION]:MIGRATIONS;
 for(let i=0;i<selected.length;i++){
  const file=selected[i],bytes=await fs.readFile(path.join(root,'supabase/migrations',file)),sha256=hash(bytes);
  const expected=reviewed.match(new RegExp('\\|\\s*0'+(i+1)+'\\s*\\|\\s*`([a-f0-9]{64})`\\s*\\|'))?.[1];
  check(expected&&sha256===expected,'migration_review_fingerprint_mismatch_'+(i+1));
  const source=bytes.toString('utf8'),stripped=stripTransactionWrappers(source);
  sources.push({file,version:file.slice(0,14),name:file.slice(15,-4),source,sha256,...stripped});
 }
 return sources;
}
function definitions(rows,baseline,mode){
 check(Array.isArray(rows)&&(mode==='synthetic_fixture'||rows.length===11),'deployment_definitions_snapshot_required');
 for(const row of rows){
  check(object(row)&&Object.keys(row).every(k=>['category','object_name','definition'].includes(k))&&typeof row.object_name==='string'&&typeof row.definition==='string','deployment_definition_row_invalid');
  if(row.category==='function'){
   const captured=baseline.find(r=>r.category==='function'&&r.object_name===row.object_name);check(captured,'deployment_definition_without_catalog');
   check(crypto.createHash('md5').update(row.definition).digest('hex')===JSON.parse(captured.details).md5,'deployment_definition_fingerprint_mismatch');
  }
 }
 check(rows.some(r=>r.category==='registry_columns'&&r.object_name==='supabase_migrations.schema_migrations')&&rows.some(r=>r.category==='view'&&r.object_name==='v_exam_cards'),'deployment_registry_view_definitions_required');
 return rows;
}
function legacyExpectation(rows){
 const captured=rows.filter(r=>r.category==='function'&&r.object_name.startsWith('receive_email_result('));
 check(captured.length===1&&captured[0].object_name===legacySignature,'legacy_rpc_signature_inventory_invalid');
 const metadata=JSON.parse(captured[0].details);
 check(typeof metadata.owner==='string'&&/^[a-z_][a-z0-9_]*$/i.test(metadata.owner)&&metadata.definer===true&&typeof metadata.md5==='string'&&/^[a-f0-9]{32}$/.test(metadata.md5),'legacy_rpc_contract_invalid');
 check(Array.isArray(metadata.acl)&&metadata.acl.length>0&&metadata.acl.every(x=>typeof x==='string'),'legacy_rpc_explicit_acl_required');
 check(Array.isArray(metadata.search_path)&&metadata.search_path.every(x=>typeof x==='string'),'legacy_rpc_search_path_invalid');
 return {signature:legacySignature,owner:metadata.owner,md5:metadata.md5,definer:true,search_path:metadata.search_path,acl:metadata.acl};
}
function guardedPrelude(rows,defs,mode,admin,sources,legacy){
 const baseline=literal(JSON.stringify(rows));
 const registryColumns=literal(defs.find(r=>r.category==='registry_columns').definition);
 const viewMD5=crypto.createHash('md5').update(defs.find(r=>r.category==='view'&&r.object_name==='v_exam_cards').definition).digest('hex');
 const auth=admin?`
  PERFORM 1 FROM auth.users WHERE id=${literal(admin.userId)}::uuid AND email=${literal(admin.email)} FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Administrador verificado ausente ou identidade divergente' USING ERRCODE='42501'; END IF;`
  :`\n  RAISE EXCEPTION 'TEMPLATE SEM ADMINISTRADOR VERIFICADO — NÃO APLICAR' USING ERRCODE='42501';`;
 const fixtureGuard=mode==='synthetic_fixture'?`\n  IF current_setting('pamvet.offline_fixture',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Pacote somente de fixture offline' USING ERRCODE='42501'; END IF;`:'';
 const reviewRefusal=mode==='administrative_review'?`\n  RAISE EXCEPTION 'REVISÃO ADMINISTRATIVA — NÃO APLICAR: confirmação final no navegador e coordenação da implantação são separadas' USING ERRCODE='42501';`:'';
 const legacyGuard=legacy?`
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='receive_email_result')<>1 OR to_regprocedure('public.'||${literal(legacy.signature)}) IS NULL THEN
    RAISE EXCEPTION 'Inventário do RPC legado divergiu antes da implantação' USING ERRCODE='40001'; END IF;
  PERFORM set_config('pamvet.legacy_rpc_transition_expected',${literal(JSON.stringify(legacy))},true);`:'';
 return `BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL standard_conforming_strings=on;
SET LOCAL search_path=pg_catalog,public;
DO $deployment_guard$
DECLARE r jsonb; d jsonb; actual jsonb; v_table text; v_name text; p oid; n text;
BEGIN
${reviewRefusal}${fixtureGuard}${auth}${legacyGuard}
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL OR to_regclass('storage.buckets') IS NULL OR to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Catálogo Supabase/registro obrigatório ausente' USING ERRCODE='40001';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid='supabase_migrations.schema_migrations'::regclass AND NOT a.attisdropped AND
      ((a.attname='version' AND t.typname='text') OR (a.attname='name' AND t.typname='text') OR (a.attname='statements' AND t.typname='_text')))<>3 THEN
    RAISE EXCEPTION 'Formato do registro de migrations não conferido' USING ERRCODE='40001';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',a.attname,'type',t.typname,'nullable',CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END) ORDER BY a.attnum),'[]'::jsonb) INTO actual FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid='supabase_migrations.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF actual IS DISTINCT FROM ${registryColumns}::jsonb THEN RAISE EXCEPTION 'Formato completo do registro divergiu' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pamvet:exam-documents-deployment-01-04',0));
  LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN (${sources.map(s=>literal(s.version)).join(',')})) THEN
    RAISE EXCEPTION 'Registro das migrations colide; conciliar sem reaplicar' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND
     (c.relname LIKE 'exam_document%' OR c.relname LIKE 'exam_collection%' OR c.relname IN ('v_exam_documents','exames_document_unique'))) OR
     EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace ns ON ns.oid=f.pronamespace WHERE ns.nspname='public' AND
       (f.proname LIKE '%exam_document%' OR f.proname LIKE '%exam_collection%' OR f.proname IN ('guard_nexus_document_exam'))) THEN
    RAISE EXCEPTION 'Schema novo ou parcial já existe; conciliar sem sobrescrever' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('exam_documents_private','exam_documents_staging')) OR
     EXISTS(SELECT 1 FROM pg_policies WHERE policyname LIKE 'exam_document%' OR policyname='restrict_document_exames_to_team') OR
     EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('guard_exam_document_item_evidence','guard_exam_card_document_delete','guard_nexus_document_exam','touch_exam_document')) OR
     EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND
       ((table_name='exam_card' AND column_name IN ('pet_id','client_code','archived_at')) OR
        (table_name='exames' AND column_name IN ('exam_document_id','storage_bucket','storage_path')))) THEN
    RAISE EXCEPTION 'Bucket/policy/trigger/coluna nova colide com implantação existente' USING ERRCODE='40001';
  END IF;
  -- Lock only the inspected legacy scope; no clinical row is read or changed here.
  LOCK TABLE public.exam_card,public.exam_item,public.exam_card_log,public.lab_shipment,public.exames,public.exam_tracking,public.pets,public.clients,public.veterinarios IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.v_exam_cards IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF md5(pg_get_viewdef('public.v_exam_cards'::regclass,true))<>${literal(viewMD5)} AND md5(pg_get_viewdef('public.v_exam_cards'::regclass,false))<>${literal(viewMD5)} THEN RAISE EXCEPTION 'View legado divergiu da definição capturada' USING ERRCODE='40001'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(${baseline}::jsonb) LOOP
    v_name:=r->>'object_name';
    IF r->>'category'='columns' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name',a.attname,'type',t.typname,'nullable',CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END) ORDER BY a.attnum),'[]'::jsonb)
        INTO actual FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=to_regclass('public.'||quote_ident(v_name)) AND a.attnum>0 AND NOT a.attisdropped;
      IF actual IS DISTINCT FROM (r->>'details')::jsonb THEN RAISE EXCEPTION 'Colunas divergentes do catálogo: %',v_name USING ERRCODE='40001'; END IF;
    ELSIF r->>'category'='relation' THEN
      SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'kind',c.relkind::text,'acl',to_jsonb(c.relacl::text[]),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',to_jsonb(c.reloptions)) INTO actual
        FROM pg_class c WHERE c.oid=to_regclass('public.'||quote_ident(v_name));
      IF actual IS DISTINCT FROM (r->>'details')::jsonb THEN RAISE EXCEPTION 'Owner/ACL/RLS divergente: %',v_name USING ERRCODE='40001'; END IF;
    ELSIF r->>'category'='function' THEN
      p:=to_regprocedure('public.'||v_name);
      SELECT jsonb_build_object('owner',pg_get_userbyid(f.proowner),'acl',to_jsonb(f.proacl::text[]),'definer',f.prosecdef,'search_path',to_jsonb(ARRAY(SELECT x FROM unnest(COALESCE(f.proconfig,'{}'::text[])) x WHERE split_part(x,'=',1)='search_path')),'md5',md5(pg_get_functiondef(f.oid))) INTO actual FROM pg_proc f WHERE f.oid=p;
      IF actual IS DISTINCT FROM (r->>'details')::jsonb THEN RAISE EXCEPTION 'RPC legado divergiu do catálogo: %',v_name USING ERRCODE='40001'; END IF;
    ELSIF r->>'category'='constraint' THEN
      v_table:=split_part(v_name,':',1);n:=substring(v_name FROM position(':' IN v_name)+1);
      SELECT to_jsonb(pg_get_constraintdef(c.oid)) INTO actual FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||quote_ident(v_table)) AND c.conname=n;
      IF actual IS DISTINCT FROM to_jsonb(r->>'details') THEN RAISE EXCEPTION 'Constraint legado divergiu: %',v_name USING ERRCODE='40001'; END IF;
    ELSIF r->>'category'='policy' THEN
      v_table:=split_part(v_name,':',1);n:=substring(v_name FROM position(':' IN v_name)+1);
      SELECT jsonb_build_object('cmd',cmd,'qual',qual,'roles',to_jsonb(roles::text[]),'permissive',permissive,'with_check',with_check) INTO actual FROM pg_policies WHERE schemaname='public' AND tablename=v_table AND policyname=n;
      IF actual IS DISTINCT FROM (r->>'details')::jsonb THEN RAISE EXCEPTION 'Policy legado divergiu: %',v_name USING ERRCODE='40001'; END IF;
    END IF;
  END LOOP;
  FOR v_table IN SELECT DISTINCT value->>'object_name' FROM jsonb_array_elements(${baseline}::jsonb) WHERE value->>'category'='columns' LOOP
    IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename=v_table)<>(SELECT count(*) FROM jsonb_array_elements(${baseline}::jsonb) x WHERE x->>'category'='policy' AND split_part(x->>'object_name',':',1)=v_table) THEN
      RAISE EXCEPTION 'Conjunto de policies mudou: %',v_table USING ERRCODE='40001';
    END IF;
  END LOOP;
END;
$deployment_guard$;
`;
}
export async function buildDeployment({mode='template',variant='standard',verifiedAdmin,catalogRows,catalogPath=path.resolve(appRoot,'../n8n-verificado-2026-10-11/preflight-supabase-catalogo-2026-10-11.json'),definitionsRows,definitionsPath=path.resolve(appRoot,'../n8n-verificado-2026-10-11/preflight-supabase-definicoes-2026-10-11.json'),root=appRoot,reviewPath}={}){
 const admin=adminInput(mode,verifiedAdmin),sources=await readReviewedSources({root,reviewPath,variant});
 const rows=catalog(catalogRows??JSON.parse(await fs.readFile(catalogPath,'utf8')),mode),catalogSha256=hash(JSON.stringify(rows));
 const defs=definitions(definitionsRows??JSON.parse(await fs.readFile(definitionsPath,'utf8')),rows,mode),definitionsSha256=hash(JSON.stringify(defs));
 const legacy=variant===LEGACY_RPC_VARIANT?legacyExpectation(rows):null;
 const prelude=guardedPrelude(rows,defs,mode,admin,sources,legacy),pieces=sources.map(s=>`\n-- SOURCE ${s.file} SHA256 ${s.sha256}; only outer transaction wrappers removed.\n${s.body}`);
 const seed=admin?`${mode==='administrative_review'?'\n-- PROPOSED SEED ONLY: mandatory review refusal prevents execution and grants no membership.':''}\nINSERT INTO public.exam_document_member(user_id,role,active) SELECT id,'admin',true FROM auth.users WHERE id=${literal(admin.userId)}::uuid AND email=${literal(admin.email)};\n`:'\n-- No administrator identity supplied. Template aborts before all DDL; no seed.\n';
 const legacyDeclaration=legacy?'\nDECLARE rpc_expected jsonb; rpc_target oid; rpc_final record; rpc_actual_acl jsonb; rpc_expected_acl jsonb;':'';
 const legacyPost=legacy?`
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.exam_document'::regclass AND tgname='guard_exam_document_admin_phase_insert' AND tgenabled='A' AND NOT tgisinternal
      AND tgfoid=to_regprocedure('public.guard_exam_document_admin_phase_insert()') AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL) THEN
    RAISE EXCEPTION 'Barreira incondicional de documentos ausente' USING ERRCODE='40001'; END IF;
  rpc_expected:=current_setting('pamvet.legacy_rpc_transition_expected')::jsonb;
  rpc_target:=to_regprocedure('public.'||(rpc_expected->>'signature'));
  IF rpc_target IS NULL OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='receive_email_result')<>1 THEN
    RAISE EXCEPTION 'Inventário final do RPC legado divergiu' USING ERRCODE='40001'; END IF;
  SELECT p.*,pg_get_userbyid(p.proowner) owner_name INTO STRICT rpc_final FROM pg_proc p WHERE p.oid=rpc_target;
  IF rpc_final.owner_name<>rpc_expected->>'owner' OR md5(pg_get_functiondef(rpc_target))<>rpc_expected->>'md5' OR NOT rpc_final.prosecdef
      OR to_jsonb(ARRAY(SELECT x FROM unnest(COALESCE(rpc_final.proconfig,'{}'::text[])) x WHERE split_part(x,'=',1)='search_path')) IS DISTINCT FROM rpc_expected->'search_path' THEN
    RAISE EXCEPTION 'Contrato final do RPC legado divergiu' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO rpc_actual_acl FROM aclexplode(COALESCE(rpc_final.proacl,acldefault('f',rpc_final.proowner))) x;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',x.grantor,'grantee',x.grantee,'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable),'[]'::jsonb)
    INTO rpc_expected_acl FROM aclexplode(ARRAY(SELECT value::aclitem FROM jsonb_array_elements_text(rpc_expected->'acl'))) x;
  IF rpc_actual_acl IS DISTINCT FROM rpc_expected_acl THEN RAISE EXCEPTION 'ACL final do RPC legado não preservado' USING ERRCODE='40001'; END IF;`:'';
 const post=`
DO $deployment_post$${legacyDeclaration}
BEGIN
  IF (SELECT count(*) FROM public.exam_document_configuration)<>1 OR NOT EXISTS(SELECT 1 FROM public.exam_document_configuration WHERE enabled_destinations='{}'::text[] AND notification_cutoff IS NULL AND group_destination_key IS NULL) THEN
    RAISE EXCEPTION 'Configuração deixou de estar pausada' USING ERRCODE='40001';
  END IF;
  IF (SELECT count(*) FROM public.exam_document_member)<>1 OR NOT EXISTS(SELECT 1 FROM public.exam_document_member WHERE role='admin' AND active${admin?' AND user_id='+literal(admin.userId)+'::uuid':''}) THEN
    RAISE EXCEPTION 'Seed restrito do administrador não confirmado' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.exam_document) OR EXISTS(SELECT 1 FROM public.exam_document_source) OR EXISTS(SELECT 1 FROM public.exam_document_delivery) OR EXISTS(SELECT 1 FROM public.exam_collection_cursor) THEN
    RAISE EXCEPTION 'Instalação não pode criar/processar histórico clínico' USING ERRCODE='40001';
  END IF;${legacyPost}
END;
$deployment_post$;
`;
 const registry='\n-- Registry records only the '+(legacy?'five':'four')+' source SQL files, never admin identity or credentials.\nINSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES\n'+sources.map(s=>'('+literal(s.version)+','+literal(s.name)+',ARRAY['+literal(s.source)+']::text[])').join(',\n')+';\nCOMMIT;\n';
 const header=`-- PRIVATE LOCAL PACKAGE. Mode=${mode}; target=${mode==='synthetic_fixture'?'OFFLINE FIXTURE ONLY':PROJECT_REF}.\n-- Catalog metadata fingerprint ${catalogSha256}. Never bypass guards or apply a template.\n`;
 const sql=header+prelude+pieces.join('\n')+seed+post+registry;
 const manifest={mode,targetProjectRef:mode==='synthetic_fixture'?'offline_fixture':PROJECT_REF,readyToApply:mode==='verified_admin',requiresSeparateApproval:true,adminIdentityIncluded:Boolean(admin),catalogRowCount:rows.length,catalogSha256,definitionsRowCount:defs.length,definitionsSha256,
  migrations:sources.map(({file,version,sha256,body,removedBegin,removedCommit})=>({file,version,sha256,strippedSha256:hash(body),removedBegin,removedCommit})),sqlSha256:hash(sql),externalCalls:0,
  clinicalHistoryProcessed:0,enabledDestinations:[],supabaseRegistryRowsPlanned:sources.length,limitations:['Identity verification/role approval is caller evidence; SQL rechecks exact auth.users identity','Catalog/definitions fingerprints cover captured metadata, not missing FK/index/trigger definitions','Single transaction needs a transaction-preserving executor and coordinated legacy consumers','No provider/runtime/PostgreSQL multi-connection contention proof']};
 if(legacy){
  Object.assign(manifest,{variant:LEGACY_RPC_VARIANT,firstAccessPhase:'admin_and_legacy_collector_only',documentIngestionBlocked:true,legacyRpcAclSnapshotSha256:hash(JSON.stringify(legacy)),retirementImplemented:false});
  manifest.limitations.unshift('Optional fifth source restores captured legacy RPC ACLs exactly and unconditionally blocks document INSERT, including service calls','RPC ACL restriction alone does not remove the document barrier; separate versioned retirement requires legacy collector pause/drain/cutover and approval');
 }
 if(mode==='administrative_review'){
  Object.assign(manifest,{reviewOnly:true,applicationBlocked:true,requiresFinalBrowserConfirmation:true});
  manifest.limitations.unshift('Administrative review always refuses execution before auth lookup, locks, DDL or seed; final browser confirmation is separate','roleAuthorized records the requested role, not an executed grant or active membership');
 }
 return {sql,manifest};
}
export async function writeDeployment(options={}){
 const {sql,manifest}=await buildDeployment(options),outDir=options.outputDir??path.resolve(appRoot,'../n8n-verificado-2026-10-11');
 const prefix=manifest.variant===LEGACY_RPC_VARIANT?'SUPABASE-EXAMES-01-05-legado-preservado':'SUPABASE-EXAMES-01-04';
 const stem=prefix+(manifest.mode==='template'?'-template-nao-aplicar':manifest.mode==='synthetic_fixture'?'-fixture-sintetica':manifest.mode==='administrative_review'?'-revisao-administrativa-nao-aplicar':'-admin-verificado');
 await fs.mkdir(outDir,{recursive:true});
 for(const [ext,value] of [['sql',sql],['json',JSON.stringify(manifest,null,2)+'\n']]){
  const final=path.join(outDir,stem+'.'+ext),temp=final+'.tmp-'+crypto.randomUUID();
  try{await fs.writeFile(temp,value,{mode:0o600,flag:'wx'});await fs.rename(temp,final);await fs.chmod(final,0o600)}finally{await fs.rm(temp,{force:true})}
 }
 return {sqlPath:path.join(outDir,stem+'.sql'),manifestPath:path.join(outDir,stem+'.json'),...manifest};
}
export async function deploymentCLIOptions(args=[]){
 check(Array.isArray(args),'deployment_cli_args_invalid');
 if(args.length===0)return {};
 check((args.length===2||(args.length===3&&args[2]==='--preserve-legacy-rpc'))&&['--verified-admin-json','--admin-review-json'].includes(args[0])&&typeof args[1]==='string'&&args[1].length>0,'usage_template_or_verified_admin_json_or_admin_review_json');
 return {mode:args[0]==='--admin-review-json'?'administrative_review':'verified_admin',verifiedAdmin:JSON.parse(await fs.readFile(args[1],'utf8')),...(args.length===3?{variant:LEGACY_RPC_VARIANT}:{})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const options=await deploymentCLIOptions(process.argv.slice(2));
 const result=await writeDeployment(options);console.log(JSON.stringify({sqlPath:result.sqlPath,manifestPath:result.manifestPath,mode:result.mode,readyToApply:result.readyToApply,sqlSha256:result.sqlSha256}));
}
