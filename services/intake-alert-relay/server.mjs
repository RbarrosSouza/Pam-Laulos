import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{status});};
const equal=(left,right)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
const validId=value=>/^[1-9]\d{0,14}$/.test(String(value))&&Number.isSafeInteger(Number(value));
const correlation=value=>typeof value==='string'&&/^pim-[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);

export function loadConfig(env=process.env){
 const secret=name=>{if(env[name]&&env[name+'_FILE'])fail('RELAY_SECRET_CONFIGURATION_INVALID',503);const value=env[name+'_FILE']?fs.readFileSync(env[name+'_FILE'],'utf8').trim():env[name];return value||'';};
 const cfg={base:env.CHATWOOT_BASE_URL,account:env.CHATWOOT_ACCOUNT_ID,inbox:env.CHATWOOT_INBOX_ID,conversation:env.CHATWOOT_CONVERSATION_ID,phone:env.EXPECTED_DESTINATION_PHONE,channel:env.EXPECTED_CHATWOOT_CHANNEL,
  upstreamToken:secret('CHATWOOT_TOKEN'),capability:secret('RELAY_CAPABILITY_TOKEN'),key:secret('RELAY_ENCRYPTION_KEY'),dbPath:env.RELAY_DB_PATH||'/data/intake-relay.sqlite',port:Number(env.PORT||8080),host:env.HOST||'0.0.0.0',maxPerHour:Number(env.MAX_NEW_ALERTS_PER_HOUR||20)};
 let url;try{url=new URL(cfg.base);}catch{fail('RELAY_CONFIGURATION_INVALID',503);}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||cfg.base.endsWith('/')||![cfg.account,cfg.inbox,cfg.conversation].every(validId)||!/^\+[1-9]\d{9,14}$/.test(cfg.phone||'')||!/^Channel::[A-Za-z]+$/.test(cfg.channel||'')||cfg.upstreamToken.length<10||/[\r\n]/.test(cfg.upstreamToken)||cfg.capability.length<32||/[\r\n]/.test(cfg.capability)||equal(cfg.capability,cfg.upstreamToken)||equal(cfg.capability,cfg.key)||equal(cfg.upstreamToken,cfg.key)||!/^[a-f\d]{64}$/i.test(cfg.key)||!Number.isSafeInteger(cfg.port)||cfg.port<1||cfg.port>65535||!Number.isSafeInteger(cfg.maxPerHour)||cfg.maxPerHour<1||cfg.maxPerHour>100)fail('RELAY_CONFIGURATION_INVALID',503);
 cfg.key=Buffer.from(cfg.key,'hex');return cfg;
}

export class JobStore{
 constructor(file,key){
  this.key=key;fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.db=new DatabaseSync(file);fs.chmodSync(file,0o600);
  this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(job_key TEXT PRIMARY KEY,body_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','started','submitted','uncertain','confirmed')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,iv BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL);");
  const keyId=digest(key),saved=this.db.prepare("SELECT value FROM metadata WHERE key='encryption_key_id'").get();
  if(saved&&saved.value!==keyId){this.db.close();fail('RELAY_PERSISTENCE_KEY_CHANGED',503);}
  this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('encryption_key_id',?)").run(keyId);
  this.db.prepare("UPDATE jobs SET state='uncertain',updated_at=? WHERE state IN ('reserved','started')").run(Date.now());
 }
 encode(jobKey,payload){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(jobKey));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);return {iv,ciphertext,tag:cipher.getAuthTag()};}
 decode(row){if(!row)return null;try{const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,row.iv);decipher.setAAD(Buffer.from(row.job_key));decipher.setAuthTag(row.tag);return {...row,payload:JSON.parse(Buffer.concat([decipher.update(row.ciphertext),decipher.final()]).toString('utf8'))};}catch{fail('RELAY_PERSISTENCE_UNREADABLE',503);}}
 get(id){return this.decode(this.db.prepare('SELECT * FROM jobs WHERE job_key=?').get(digest(id)));}
 reserve(body,maxPerHour){
  const id=body.content_attributes.pam_intake_correlation,jobKey=digest(id),bodyHash=digest(JSON.stringify(body));this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare('SELECT * FROM jobs WHERE job_key=?').get(jobKey);
   if(row){if(row.body_hash!==bodyHash)fail('RELAY_IDEMPOTENCY_CONFLICT',409);this.db.exec('COMMIT');return {fresh:false,job:this.decode(row)};}
   if(Number(this.db.prepare('SELECT count(*) n FROM jobs WHERE created_at>=?').get(Date.now()-3600000).n)>=maxPerHour)fail('RELAY_ALERT_RATE_LIMIT',429);
   const payload={request:body},encrypted=this.encode(jobKey,payload),now=Date.now();
   this.db.prepare("INSERT INTO jobs VALUES(?,?,'reserved',?,?,?,?,?)").run(jobKey,bodyHash,now,now,encrypted.iv,encrypted.ciphertext,encrypted.tag);
   this.db.exec('COMMIT');return {fresh:true,job:this.get(id)};
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
 update(job,state,extra={}){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const current=this.get(job.payload.request.content_attributes.pam_intake_correlation);if(!current)fail('RELAY_PERSISTENCE_MISSING',503);
   const conflict=current.payload.conflict===true||extra.conflict===true||Boolean(current.payload.externalId&&extra.externalId&&current.payload.externalId!==extra.externalId);
   const payload={...current.payload,...extra,request:current.payload.request,...(current.payload.externalId?{externalId:current.payload.externalId}:{}),...(conflict?{conflict:true}:{})};
   if(conflict)state='uncertain';else if(current.state==='confirmed'){state='confirmed';if(!['delivered','read'].includes(extra.observed))payload.observed=current.payload.observed;}
   if(state!==current.state||JSON.stringify(payload)!==JSON.stringify(current.payload)){const encrypted=this.encode(job.job_key,payload);this.db.prepare('UPDATE jobs SET state=?,updated_at=?,iv=?,ciphertext=?,tag=? WHERE job_key=?').run(state,Date.now(),encrypted.iv,encrypted.ciphertext,encrypted.tag,job.job_key);}
   this.db.exec('COMMIT');return this.get(payload.request.content_attributes.pam_intake_correlation);
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}

function validateBody(value){
 if(!object(value)||Object.keys(value).some(key=>!['content','message_type','private','content_attributes'].includes(key))||typeof value.content!=='string'||Buffer.byteLength(value.content)>4096||!value.content.startsWith('Pam Laudos:')||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.content)||value.message_type!=='outgoing'||value.private!==false||!object(value.content_attributes)||Object.keys(value.content_attributes).length!==1||!correlation(value.content_attributes.pam_intake_correlation)||!value.content.endsWith('[PAM-INTAKE:'+value.content_attributes.pam_intake_correlation+']'))fail('RELAY_ALERT_BODY_INVALID');
 return {content:value.content,message_type:'outgoing',private:false,content_attributes:{pam_intake_correlation:value.content_attributes.pam_intake_correlation}};
}
async function readBody(req){
 return new Promise((resolve,reject)=>{let total=0,parts=[],done=false;req.on('data',chunk=>{if(done)return;total+=chunk.length;if(total>8192){done=true;parts=[];reject(Object.assign(new Error('RELAY_BODY_TOO_LARGE'),{status:413}));return;}parts.push(chunk);});req.on('end',()=>{if(done)return;try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch{reject(Object.assign(new Error('RELAY_JSON_INVALID'),{status:400}));}});req.on('error',()=>reject(Object.assign(new Error('RELAY_REQUEST_INCOMPLETE'),{status:400})));});
}

export function createRelay(cfg,{fetchImpl=fetch,store=new JobStore(cfg.dbPath,cfg.key)}={}){
 const prefix='/api/v1/accounts/'+cfg.account+'/conversations/'+cfg.conversation;let active=0;
 async function upstream(suffix,method='GET',body){
  let response;try{response=await fetchImpl(cfg.base+prefix+suffix,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{api_access_token:cfg.upstreamToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}catch{fail('RELAY_UPSTREAM_UNCONFIRMED',503);}
  if(response.status<200||response.status>=300)fail('RELAY_UPSTREAM_UNAVAILABLE',503);
  const chunks=[];let size=0;try{for await(const chunk of response.body){size+=chunk.length;if(size>1048576){await response.body.cancel?.().catch(()=>{});fail('RELAY_UPSTREAM_TOO_LARGE',503);}chunks.push(chunk);}const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(data))fail('RELAY_UPSTREAM_INVALID',503);return data;}catch(e){if(e.status)throw e;fail('RELAY_UPSTREAM_INVALID',503);}
 }
 async function destination(){
  const value=await upstream(''),sender=value.meta?.sender||{},raw=String(sender.phone_number||''),phone=/^[+0-9 ()-]+$/.test(raw)?'+'+raw.replace(/\D/g,''):'';
  const containers=[value,value.meta,sender,value.additional_attributes,value.custom_attributes,sender.additional_attributes,sender.custom_attributes].filter(object);
  const group=containers.some(c=>['is_group','isGroup'].some(k=>c[k]!=null&&![false,0,'false','0',''].includes(c[k]))||c.group_id!=null&&c.group_id!==''||c.group_type!=null&&!['','direct','private','individual','contact'].includes(String(c.group_type).toLowerCase())||['identifier','jid','remoteJid','remote_jid','chat_id','chatId','group_jid','source_id'].some(k=>typeof c[k]==='string'&&/(?:@g\.us|@broadcast|@newsletter)(?:$|:)/i.test(c[k])));
  if(String(value.id)!==String(cfg.conversation)||String(value.inbox_id)!==String(cfg.inbox)||(value.account_id!=null&&String(value.account_id)!==String(cfg.account))||phone!==cfg.phone||(value.meta?.channel||value.channel)!==cfg.channel||group)fail('RELAY_DESTINATION_MISMATCH',409);
  return {relay_contract:'exam_intake_relay_v1',id:Number(cfg.conversation),inbox_id:Number(cfg.inbox),account_id:Number(cfg.account),meta:{channel:cfg.channel,sender:{phone_number:cfg.phone}}};
 }
 function publicJob(job){return {...(job.payload.externalId?{id:Number(job.payload.externalId),status:job.payload.observed||'sent'}:{}),relay:{state:job.state,dispatch_attempted:job.state!=='reserved',conflict:job.payload.conflict===true}};}
 function observe(message){
  const attr=message.content_attributes?.pam_intake_correlation,footer=typeof message.content==='string'?message.content.match(/\[PAM-INTAKE:(pim-[a-f\d-]+)\]$/i)?.[1]:null;
  if(attr!=null&&footer&&attr!==footer){for(const id of [attr,footer])if(correlation(id)){const job=store.get(id);if(job)store.update(job,'uncertain',{conflict:true,errorCode:'CORRELATION_ATTRIBUTES_CONFLICT'});}return null;}const id=attr||footer;if(!correlation(id))return null;const job=store.get(id);
  if(!job||message.private!==false||![1,'outgoing'].includes(message.message_type)||message.content!==job.payload.request.content)return null;
  if(job.payload.externalId&&String(message.id)!==job.payload.externalId)return store.update(job,'uncertain',{conflict:true,errorCode:'CORRELATION_CONFLICT'});
  if(!['created','sent','delivered','read'].includes(message.status))return job;
  const delivered=['delivered','read'].includes(message.status);
  return store.update(job,job.payload.conflict?'uncertain':job.state==='confirmed'||delivered?'confirmed':'submitted',{externalId:String(message.id),observed:job.state==='confirmed'&&!delivered?job.payload.observed:message.status});
 }
 async function handle(req,res){
  const send=(status,body)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  if(req.url==='/healthz'&&req.method==='GET'){send(200,{ok:true});return;}
  try{
   const token=(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1]||'';if(!equal(token,cfg.capability))fail('RELAY_UNAUTHORIZED',401);
   if(active>=8)fail('RELAY_BUSY',503);active++;
   try{
    const url=new URL(req.url,'http://relay.invalid');
    if(req.method==='GET'&&url.pathname===prefix&&!url.search){send(200,await destination());return;}
    if(req.method==='GET'&&url.pathname===prefix+'/messages'){
     if([...url.searchParams.keys()].some(k=>k!=='before')||url.searchParams.getAll('before').length>1||url.searchParams.has('before')&&!validId(url.searchParams.get('before')))fail('RELAY_QUERY_FORBIDDEN');
     await destination();const before=url.searchParams.get('before');const body=await upstream('/messages'+(before?'?before='+before:''));
     if(!Array.isArray(body.payload)||body.payload.length>100)fail('RELAY_PAGE_INVALID',503);
     const seen=new Set();const payload=body.payload.map(message=>{
      if(!validId(message.id)||seen.has(String(message.id))||before&&Number(message.id)>=Number(before)||(message.conversation_id!=null&&String(message.conversation_id)!==String(cfg.conversation))||(message.inbox_id!=null&&String(message.inbox_id)!==String(cfg.inbox))||(message.account_id!=null&&String(message.account_id)!==String(cfg.account)))fail('RELAY_PAGE_INVALID',503);seen.add(String(message.id));
      const job=observe(message);return {id:message.id,created_at:message.created_at,status:message.status,private:message.private,message_type:message.message_type,conversation_id:Number(cfg.conversation),inbox_id:Number(cfg.inbox),content:job?message.content:'',content_attributes:job?{pam_intake_correlation:job.payload.request.content_attributes.pam_intake_correlation}:{}};
     });send(200,{payload});return;
    }
    if(req.method==='POST'&&url.pathname===prefix+'/messages'&&!url.search){
     if(!(req.headers['content-type']||'').startsWith('application/json'))fail('RELAY_JSON_REQUIRED',415);
     const body=validateBody(await readBody(req));const existing=store.get(body.content_attributes.pam_intake_correlation);
     if(existing){if(existing.body_hash!==digest(JSON.stringify(body)))fail('RELAY_IDEMPOTENCY_CONFLICT',409);send(200,publicJob(existing));return;}
     await destination();const reservation=store.reserve(body,cfg.maxPerHour);if(!reservation.fresh){send(200,publicJob(reservation.job));return;}
     // The SQLite FULL-synchronous write precedes the only provider POST.
     let job=store.update(reservation.job,'started');
     try{const receipt=await upstream('/messages','POST',body);if(!validId(receipt.id))fail('RELAY_PROVIDER_ACK_INVALID',503);job=store.update(job,'submitted',{externalId:String(receipt.id),observed:'created'});}
     catch{job=store.update(job,'uncertain',{errorCode:'PROVIDER_ACK_UNCONFIRMED'});}
     send(202,publicJob(job));return;
    }
    if(req.method==='GET'&&url.pathname.startsWith('/v1/jobs/')&&!url.search){
     const id=url.pathname.slice('/v1/jobs/'.length);if(!correlation(id))fail('RELAY_JOB_INVALID');const job=store.get(id);if(!job)fail('RELAY_JOB_NOT_FOUND',404);send(200,publicJob(job));return;
    }
    fail('RELAY_ROUTE_FORBIDDEN',404);
   }finally{active--;}
  }catch(e){req.resume();send(e.status||503,{error:e.status?e.message:'RELAY_INTERNAL_UNAVAILABLE'});}
 }
 const server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},handle);server.maxRequestsPerSocket=20;
 return {server,store,close:()=>new Promise(resolve=>{server.close(()=>{store.close();resolve();});server.closeIdleConnections();})};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 process.umask(0o077);try{const cfg=loadConfig(),app=createRelay(cfg);app.server.listen(cfg.port,cfg.host,()=>console.log('intake-alert-relay ready'));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close().then(()=>process.exit(0)));}catch{console.error('intake-alert-relay configuration or persistence unavailable');process.exitCode=1;}
}
