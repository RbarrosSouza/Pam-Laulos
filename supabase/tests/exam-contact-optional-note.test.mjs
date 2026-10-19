// Actual migration SQL on isolated PGlite; no clinical/provider I/O.
// Optional reaction integration: set EXAM_CONTACT_REACTION_SQL to the reviewed
// migration 14 extracted with git show. Its bytes are pinned below, not copied
// into this branch and not replaced with a fake outbox implementation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {collectionFixtureDB} from './collection-db.fixture.mjs';

const {db,role,rpc}=await collectionFixtureDB();
const vet='10000000-0000-0000-0000-000000000001',admin='10000000-0000-0000-0000-000000000002';
const reception='10000000-0000-0000-0000-000000000003',outsider='10000000-0000-0000-0000-000000000004';
const inactive='10000000-0000-0000-0000-000000000005',pet='20000000-0000-0000-0000-000000000001';
const migration=new URL('../migrations/20261019000015_exam_contact_optional_note.sql',import.meta.url);
let passed=0,serial=0;
const check=async(name,fn)=>{await fn();console.log(`ok ${++passed} - ${name}`);};
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
async function as(name,uid=null){await role(name);await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[uid||'']);}
const noteRow=fixture=>one('SELECT * FROM exam_document_item WHERE document_id=$1 AND exam_item_id=$2',[fixture.id,fixture.items[0]]);
const contact=(fixture,note=null,extra={})=>rpc('record_exam_document_contact',[fixture.id,extra.items??fixture.items,extra.channel===undefined?'whatsapp':extra.channel,note,
  extra.at===undefined?new Date().toISOString():extra.at]);
async function document({count=1,sharedItem,fileStatus='saved',identification='confirmed',group=false}={}){
  await as('service_role');
  const n=++serial,id=crypto.randomUUID(),hash=n.toString(16).padStart(64,'0');
  await db.query(`INSERT INTO exam_document(id,original_name,file_status,sha256,size_bytes,drive_file_id,received_at,
      pet_id,identification_status,link_method,link_confirmed_at,confirmed_data)
    VALUES($1,'Synthetic optional note.pdf',$2,$3,123,$4,now()-interval '1 minute',$5,$6,'automatic',now(),$7)`,
    [id,fileStatus,hash,'fixture-drive-'+n,pet,identification,JSON.stringify({pet_name:'Luna Fixture',client_name:'Tutor Fixture',exam_type:'Hemograma',exam_date:'2026-10-18'})]);
  let cardId;
  if(sharedItem)cardId=(await one('SELECT exam_card_id FROM exam_item WHERE id=$1',[sharedItem])).exam_card_id;
  else cardId=(await one("INSERT INTO exam_card(pet_id,client_code,pet_name,client_name,status,origin) VALUES($1,'C1','Luna Fixture','Tutor Fixture','exame_pronto','manual') RETURNING id",[pet])).id;
  const items=[];
  for(let i=0;i<count;i++){
    const itemId=sharedItem||(await one("INSERT INTO exam_item(exam_card_id,exam_type,result_received,result_received_at) SELECT $1,'Hemograma',true,received_at FROM exam_document WHERE id=$2 RETURNING id",[cardId,id])).id;
    await db.query("INSERT INTO exam_document_item(document_id,exam_item_id,confirmation_method) VALUES($1,$2,'automatic')",[id,itemId]);items.push(itemId);
  }
  if(group)await db.query(`INSERT INTO exam_document_delivery(document_id,destination,destination_key,status,sent_at,external_id)
    VALUES($1,'group','fixture-optional-note','sent',now()-interval '30 seconds',$2)`,[id,String(10000+n)]);
  await as('authenticated',vet);
  return {id,items,cardId};
}

try{
  await db.exec('RESET ROLE');
  await db.exec(`ALTER TABLE veterinarios ADD COLUMN ativo boolean DEFAULT true,ADD COLUMN crmv text,ADD COLUMN avatar_url text;
    ALTER TABLE exam_card ADD COLUMN vet_id uuid REFERENCES veterinarios(id);
    ALTER TABLE exam_tracking ALTER COLUMN pet_id TYPE text USING pet_id::text;
    ALTER TABLE exam_tracking ALTER COLUMN veterinario_id TYPE text USING veterinario_id::text;
    ALTER TABLE exam_tracking ADD COLUMN created_at timestamptz DEFAULT now();
    CREATE TABLE sales_header(id uuid PRIMARY KEY,pet_id varchar,customer_id varchar,veterinarian_id varchar,sale_date date,status varchar);
    INSERT INTO auth.users(id) VALUES('${vet}'),('${admin}'),('${reception}'),('${outsider}'),('${inactive}');
    INSERT INTO exam_document_member(user_id,role,active) VALUES('${vet}','vet',true),('${admin}','admin',true),('${reception}','reception',true),('${inactive}','vet',false);
    INSERT INTO clients("Código","Nome") VALUES('C1','Tutor Fixture');
    INSERT INTO pets(id,client_code,name) VALUES('${pet}','C1','Luna Fixture');`);
  for(const file of ['20261016000006_exam_operational_flow.sql','20261016000007_exam_clinical_group_eligibility.sql',
    '20261016000008_exam_gmail_origin_identity.sql','20261016000009_exam_group_after_processing.sql',
    '20261016000010_exam_group_without_identification.sql','20261016000011_exam_unique_patient_matching.sql',
    '20261018000012_exam_document_responsibility.sql','20261018000013_exam_pending_summary.sql'])
    await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await db.exec('GRANT ALL ON public.exam_card,public.exam_item,public.exam_card_log,public.sales_header,public.veterinarios,public.exam_tracking TO service_role');
  await as('service_role');await db.exec('UPDATE exam_document_configuration SET ingestion_enabled=true');
  let reaction=false;
  if(process.env.EXAM_CONTACT_REACTION_SQL){
    const sql=await readFile(process.env.EXAM_CONTACT_REACTION_SQL,'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'),'7021c7109d7c1b3bf00889d5c2859a491534b067d863497d229fd4f9e34a9d2d','Only the reviewed migration 14 is accepted');
    await db.exec('RESET ROLE');await db.exec(sql);reaction=true;
  }
  const existing=await document();await contact(existing,'Observação histórica preservada');
  const before=await noteRow(existing);
  const acl=()=>one("SELECT proowner,proacl::text,prosecdef,proconfig FROM pg_proc WHERE oid='public.record_exam_document_contact(uuid,uuid[],text,text,timestamptz)'::regprocedure");
  await db.exec('RESET ROLE');const oldAcl=await acl();await db.exec(await readFile(migration,'utf8'));await as('authenticated',vet);
  await check('installation preserves historical contact evidence, privileges, definer and search path',async()=>{
    assert.deepEqual(await noteRow(existing),before);assert.deepEqual(await acl(),oldAcl);
  });
  for(const [label,value] of [['NULL',null],['empty',''],['spaces','   '],['tabs and line breaks',' \t\r\n  ']]){
    await check(label+' observation records contact with SQL NULL and the normal audit event',async()=>{
      const doc=await document();await contact(doc,value);const row=await noteRow(doc);
      assert.equal(row.contact_note,null);assert.equal(row.contacted_by,vet);assert.ok(row.contacted_at);assert.equal(row.contact_channel,'whatsapp');
      const event=await one("SELECT * FROM exam_document_event WHERE document_id=$1 AND event_type='contact_recorded'",[doc.id]);
      assert.equal(event.actor_id,vet);assert.deepEqual(event.details.item_ids,doc.items);assert.equal(event.details.channel,'whatsapp');
      assert.equal((await one('SELECT contacted FROM exam_item WHERE id=$1',[doc.items[0]])).contacted,true);
    });
  }
  await check('omitting the note and contact date uses the same RPC with safe defaults',async()=>{
    const doc=await document();await db.query('SELECT public.record_exam_document_contact(p_document_id=>$1,p_item_ids=>$2,p_channel=>$3)',[doc.id,doc.items,'phone']);
    assert.equal((await noteRow(doc)).contact_note,null);assert.equal((await noteRow(doc)).contact_channel,'phone');
  });
  await check('meaningful notes retain exact supplied text, including internal and edge whitespace',async()=>{
    const doc=await document(),note='  Texto clínico fictício.\nSegunda linha.  ';await contact(doc,note);assert.equal((await noteRow(doc)).contact_note,note);
  });
  await check('blank replay by another authorized actor never erases previous note, author or date',async()=>{
    await as('authenticated',admin);await contact(existing,null,{at:new Date(Date.now()+1000).toISOString()});
    assert.deepEqual(await noteRow(existing),before);
    assert.equal((await one('SELECT contacted_at,contacted_by FROM exam_item WHERE id=$1',[existing.items[0]])).contacted_by,vet);
  });
  await check('replay cannot add a late observation to an already recorded blank contact',async()=>{
    const doc=await document();await contact(doc,null);const saved=await noteRow(doc);await contact(doc,'Não deve substituir evidência');assert.deepEqual(await noteRow(doc),saved);
  });
  await check('selected subset leaves the other document items open and cannot complete the card',async()=>{
    const doc=await document({count:2});await contact(doc,null,{items:[doc.items[0]]});
    assert.equal((await one('SELECT contacted_at FROM exam_document_item WHERE document_id=$1 AND exam_item_id=$2',[doc.id,doc.items[1]])).contacted_at,null);
    assert.notEqual((await one('SELECT status FROM exam_card WHERE id=$1',[doc.cardId])).status,'contato_realizado');
  });
  await check('one shared item completes only after every linked document has contact evidence',async()=>{
    const first=await document(),second=await document({sharedItem:first.items[0]});
    await contact(first,null);assert.equal((await one('SELECT contacted FROM exam_item WHERE id=$1',[first.items[0]])).contacted,false);
    await contact(second,' \t\n');assert.equal((await one('SELECT contacted FROM exam_item WHERE id=$1',[first.items[0]])).contacted,true);
  });
  const guarded=await document();
  await check('anonymous, nonmember, inactive member and reception still cannot record contact',async()=>{
    for(const [name,uid] of [['anon',null],['authenticated',outsider],['authenticated',inactive],['authenticated',reception]]){
      await as(name,uid);await assert.rejects(()=>contact(guarded,null),error=>error.code==='42501');
    }await as('authenticated',vet);assert.equal((await noteRow(guarded)).contacted_at,null);
  });
  await check('management can record contact without an observation',async()=>{
    await as('authenticated',admin);await contact(guarded,null);assert.equal((await noteRow(guarded)).contacted_by,admin);
  });
  await check('channel and contact date guards remain mandatory with an optional observation',async()=>{
    const doc=await document();
    for(const extra of [{channel:null},{channel:'invalid'},{at:null},{at:new Date(Date.now()+600000).toISOString()},{at:new Date(Date.now()-120000).toISOString()}])
      await assert.rejects(()=>contact(doc,null,extra),error=>error.message==='Canal e data de contato válidos são obrigatórios');
    assert.equal((await noteRow(doc)).contacted_at,null);
  });
  await check('empty, NULL or unrelated item selections still fail without recording an event',async()=>{
    const doc=await document();
    for(const items of [[],[crypto.randomUUID()]])await assert.rejects(()=>contact(doc,null,{items}),/Selecione somente itens/);
    await assert.rejects(()=>rpc('record_exam_document_contact',[doc.id,null,'whatsapp',null,new Date().toISOString()]),/Selecione somente itens/);
    assert.equal(Number((await one("SELECT count(*) n FROM exam_document_event WHERE document_id=$1 AND event_type='contact_recorded'",[doc.id])).n),0);
  });
  await check('a result must still be saved and its patient confirmed before contact',async()=>{
    for(const options of [{fileStatus:'pending'},{identification:'review'}]){
      const doc=await document(options);await assert.rejects(()=>contact(doc,null),/Confirme o paciente e preserve/);assert.equal((await noteRow(doc)).contacted_at,null);
    }
  });
  await check('competing blank contact calls preserve the first evidence and its projection',async()=>{
    const doc=await document(),at=new Date().toISOString();
    await Promise.all([contact(doc,null,{at}),contact(doc,' \t\n',{at:new Date(Date.now()+1000).toISOString()})]);
    const row=await noteRow(doc);assert.equal(row.contact_note,null);assert.equal(new Date(row.contacted_at).toISOString(),at);
    assert.equal(new Date((await one('SELECT contacted_at FROM exam_item WHERE id=$1',[doc.items[0]])).contacted_at).toISOString(),at);
  });
  if(reaction){
    await check('migration does not activate or modify the installed reaction outbox',async()=>{
      await as('service_role');const cfg=await one('SELECT * FROM exam_reaction_configuration');assert.equal(cfg.enabled,false);assert.equal(cfg.activation_cutoff,null);
      assert.equal(Number((await one('SELECT count(*) n FROM exam_document_reaction')).n),0);
    });
    const doc=await document({count:2,group:true});
    await as('service_role');await db.query("UPDATE exam_document_configuration SET group_destination_key='fixture-optional-note',enabled_destinations=ARRAY['group','drive','processing']");
    await db.query('UPDATE exam_reaction_configuration SET enabled=true,activation_cutoff=now()-interval \'5 minutes\',chatwoot_actor_id=1');
    await as('authenticated',vet);await contact(doc,null,{items:[doc.items[0]]});
    await check('a blank-note partial contact never makes a reaction candidate',async()=>{
      await as('service_role');assert.equal((await rpc('preview_exam_contact_reactions',[])).eligible_total,0);
    });
    await as('authenticated',vet);await contact(doc,' \t\n',{items:[doc.items[1]]});
    await check('all items contacted without notes yield the same prospective original-message reaction once',async()=>{
      await as('service_role');const p=await rpc('preview_exam_contact_reactions',[]);assert.equal(p.eligible_total,1);assert.equal(p.tasks[0].document_id,doc.id);
      const reservation=await rpc('reserve_exam_contact_reactions',['fixture-optional-note',1]);assert.equal(reservation.tasks.length,1);const task=reservation.tasks[0];
      const args=[task.reaction_id,task.lease_token,task.destination_key,task.external_message_id,task.emoji,task.actor_id];
      assert.equal((await rpc('begin_exam_contact_reaction',args)).dispatch_allowed,true);assert.equal((await rpc('begin_exam_contact_reaction',args)).dispatch_allowed,false);
      await as('authenticated',vet);await contact(doc,null);
      await as('service_role');assert.equal((await rpc('reserve_exam_contact_reactions',['fixture-after-replay',1])).tasks.length,0);
      assert.equal(Number((await one('SELECT count(*) n FROM exam_document_reaction WHERE document_id=$1',[doc.id])).n),1);
    });
  }else console.log('# reaction integration not run: provide EXAM_CONTACT_REACTION_SQL with the reviewed migration 14');
  console.log(`${passed} optional contact observation SQL checks passed${reaction?' (including actual reaction migration 14)':''}`);
}finally{await db.close();}
