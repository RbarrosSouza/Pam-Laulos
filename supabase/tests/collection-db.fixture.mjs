import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {PGlite} = require('@electric-sql/pglite');
const root = new URL('../../', import.meta.url);

// Same minimal legacy schema boundary used by exam-documents.test.mjs. All
// pipeline/staging/collection functions below are actual migration SQL.
export async function collectionFixtureDB({dataDir, initialize = true} = {}) {
  const db = new PGlite(dataDir);
  if (initialize) {
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
    CREATE TABLE clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"Código" text,"Nome" text,"Celular" text,"E-mail" text);
    CREATE TABLE pets(id uuid PRIMARY KEY,client_code text,code text,name text,species text,breed text,chip text);
    CREATE TABLE veterinarios(id uuid PRIMARY KEY,nome text);
    CREATE TABLE exam_tracking(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_id text,pet_id uuid,origin text NOT NULL DEFAULT 'venda',
      client_code text,exam_type text,lab_name text,pet_name_parsed text,client_name_parsed text,veterinario_id uuid,sale_product_name text);
    CREATE TABLE exames(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pet_id uuid NOT NULL REFERENCES pets(id),nome text NOT NULL,data_exame date NOT NULL DEFAULT current_date,
      arquivo_url text,arquivo_nome text,arquivo_tipo text,arquivo_tamanho integer,observacoes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON ALL TABLES IN SCHEMA public,storage,auth TO service_role;
  `);
  await db.exec(await readFile(new URL('supabase-migration.sql', root), 'utf8'));
  for (const file of ['20260324000001_bridge_tracking_to_card.sql','20260327000001_lab_shipment_and_history.sql',
    '20260324000002_rpc_receive_email_result.sql','20260930000001_exams_in_group.sql','20261010000001_exam_documents.sql',
    '20261010000002_exam_document_card_guards.sql','20261010000003_exam_document_staging_journal.sql','20261010000004_exam_collection_checkpoint.sql']) {
    await db.exec(await readFile(new URL(`supabase/migrations/${file}`, root), 'utf8'));
  }
  }
  async function role(name) {
    if (!['service_role', 'authenticated', 'anon'].includes(name)) throw new Error('Invalid fixture role');
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.role','${name}',false); SET ROLE ${name}`);
  }
  async function rpc(name, args) {
    if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid fixture RPC');
    const slots = args.map((_, i) => `$${i+1}`).join(',');
    return (await db.query(`SELECT public.${name}(${slots}) result`, args)).rows[0].result;
  }
  await role('service_role');
  if (initialize) await db.query("UPDATE exam_document_configuration SET enabled_destinations=ARRAY['processing','drive']");
  return {db, role, rpc};
}
