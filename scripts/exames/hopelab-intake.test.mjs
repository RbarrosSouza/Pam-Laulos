import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {CONFIG,buildWorkflows} from './operacional-build.mjs';
import * as runtime from './operacional-runtime.mjs';

const cfg={...CONFIG,intakeCutoff:'2026-10-16T00:00:00Z',windowStart:'2026-10-16T00:00:00Z',sweepEnd:'2026-10-17T00:00:00Z',allowedSenders:[]};
const url='https://hopelab.exames.vet.br/laudos/download/37/1234/'+'a'.repeat(32)+'/'+'b'.repeat(32);
const bytes=Buffer.from('%PDF-1.4\nDocumento inteiramente fictício.\n%%EOF');
const docId='11111111-1111-4111-a111-111111111111';
const meta={id:'synthetic-hopelab-message',internalDate:String(Date.parse('2026-10-16T12:00:00Z')),payload:{partId:'',mimeType:'multipart/alternative',headers:[{name:'From',value:'Hopelab <hopelab@exames.vet.br>'},{name:'Subject',value:'Exame finalizado (FICTÍCIO)'},{name:'Message-ID',value:'<synthetic@example.invalid>'}],parts:[{partId:'0',mimeType:'text/plain',body:{size:0}},{partId:'1',mimeType:'text/html',body:{size:0}}]}};
const body=(plain=url+'?utm_source=email',html='<a href="https://tracking.example.invalid/click">'+url+'?utm_source=email</a>')=>{
 const message=structuredClone(meta);
 message.payload.parts.forEach((part,index)=>{const value=Buffer.from(index?html:plain);part.body={size:value.length,data:value.toString('base64url')};});
 return message;
};
const notice=()=>runtime.inspectHopelabNotice(meta,meta.id,cfg);
const origin=()=>runtime.parseHopelabNotice(body(),notice(),cfg)[0];
const reserved=()=>runtime.decideReservation(origin(),{document_id:docId,document:{id:docId,file_status:'pending'}});
const response={statusCode:200,headers:{'content-type':'application/pdf'}};

test('only the exact sender and expected subject permit a body read, within the existing cutoff',()=>{
 assert.equal(notice().id,meta.id);
 for(const [name,value] of [['From','Someone <hopelab@exames.vet.br.evil.invalid>'],['From','forwarder@example.invalid'],['Subject','Outra mensagem']]){
  const message=structuredClone(meta);message.payload.headers.find(h=>h.name===name).value=value;
  assert.equal(runtime.inspectHopelabNotice(message,message.id,cfg),null);
 }
 assert.equal(runtime.inspectHopelabNotice({...meta,internalDate:String(Date.parse(cfg.intakeCutoff)-1)},meta.id,cfg),null);
 const withPdf=structuredClone(meta);withPdf.payload.parts.push({partId:'2',mimeType:'application/pdf',filename:'result.pdf',body:{attachmentId:'attachment',size:bytes.length}});
 assert.equal(runtime.inspectHopelabNotice(withPdf,meta.id,cfg),null);
 assert.throws(()=>runtime.inspectHopelabNotice(meta,'different-id',cfg),/identity_mismatch/);
});

test('visible direct link is canonicalized, repeated plain/HTML links dedupe, tracking href is never followed',()=>{
 const origins=runtime.parseHopelabNotice(body(),notice(),cfg);assert.equal(origins.length,1);
 const item=origins[0],hash=crypto.createHash('sha256').update(url).digest('hex');
 assert.equal(item.attachment.downloadUrl,url);assert.equal(item.source.attachment_id,'hopelab-link:'+hash);
 assert.equal(item.source.metadata.provider,'hopelab_link');assert.equal(item.source.metadata.exam_candidate,true);
 assert.equal(item.source.metadata.unknown_sender,true);assert.equal(item.source.metadata.gmail_part_id,undefined);
 assert.equal(item.source.account_id,'gmail:'+cfg.mailbox);assert.equal(item.source.message_id,'hopelab-result:'+hash);
 assert.equal(item.source.metadata.gmail_message_id,meta.id);assert.equal(item.message.id,meta.id);
 assert(!JSON.stringify(item.source).includes(url));assert(!JSON.stringify(item.source).includes('a'.repeat(32)));
 const changedTracking=runtime.parseHopelabNotice(body(url,'<a href="https://other-tracker.example.invalid/new">'+url+'</a>'),notice(),cfg)[0];
 assert.equal(changedTracking.source.attachment_id,item.source.attachment_id);
});

test('untrusted URL forms and href-only links create a visible missing-link origin without a download',()=>{
 for(const candidate of [url.replace('https:','http:'),url.replace('hopelab.exames.vet.br','hopelab.exames.vet.br.evil.invalid'),url.replace('hopelab.exames.vet.br','127.0.0.1'),url.replace('hopelab.exames.vet.br','user@hopelab.exames.vet.br'),url+'#fragment',url+'?redirect=https://evil.invalid',url+'/extra',url.replace('/laudos/download/','/admin/')]){
  assert.throws(()=>runtime.canonicalHopelabUrl(candidate),/not_allowed/);
  const [item]=runtime.parseHopelabNotice(body(candidate,'<a href="'+url+'">Baixar</a>'),notice(),cfg);
  assert.equal(item.missing,true);assert.equal(item.attachment.downloadUrl,null);
 }
});

test('body identity, encoding, size and PDF-before-reservation are rejected',()=>{
 for(const mutate of [m=>{m.id='other';},m=>{m.payload.headers[0].value='evil@example.invalid';},m=>{m.payload.parts[0].body.data='bad!';},m=>{m.payload.parts[0].body.size=999;},m=>{m.payload.parts[0].mimeType='application/pdf';}]){
  const message=body();mutate(message);assert.throws(()=>runtime.parseHopelabNotice(message,notice(),cfg));
 }
 assert.throws(()=>runtime.parseHopelabNotice(body('x'.repeat(1048577),''),notice(),cfg),/limit/);
});

test('saved origins skip GET and duplicate bytes reuse the established canonical receipt',()=>{
 const first=origin(),again=origin();assert.equal(first.source.attachment_id,again.source.attachment_id);
 assert.equal(runtime.decideReservation(again,{document_id:docId,document:{id:docId,file_status:'saved'}}).skip,true);
 const decoded=runtime.decodeHopelabOriginal(bytes,response,reserved(),cfg);
 assert.equal(decoded.json.sizeBytes,bytes.length);assert.equal(decoded.json.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 const canonical='22222222-2222-4222-a222-222222222222';
 const stage={document_id:canonical,drive_file_id:'existing-drive-file',claimed:false,upload_required:false,document:{id:canonical,sha256:decoded.json.sha256,size_bytes:bytes.length,file_status:'saved',drive_file_id:'existing-drive-file'}};
 assert.equal(runtime.validateStage(stage,decoded.json).upload_required,false);
});

test('two Gmail messages for one Hopelab URL reserve the same origin and skip the regenerated second PDF',()=>{
 const first=origin(),secondBody=body();secondBody.id='second-gmail-message';
 const secondMeta=structuredClone(secondBody);for(const part of secondMeta.payload.parts)delete part.body.data;
 const secondNotice=runtime.inspectHopelabNotice(secondMeta,secondMeta.id,cfg);
 const second=runtime.parseHopelabNotice(secondBody,secondNotice,cfg)[0];
 const tuple=item=>[item.source.channel,item.source.account_id,item.source.message_id,item.source.attachment_id];
 assert.deepEqual(tuple(second),tuple(first));
 assert.notEqual(second.source.metadata.gmail_message_id,first.source.metadata.gmail_message_id);
 assert.equal(second.message.id,secondBody.id);assert.equal(first.message.id,meta.id);
 const regenerated=Buffer.from('%PDF-1.4\nSame report, new generation timestamp.\n%%EOF');
 assert.notEqual(crypto.createHash('sha256').update(regenerated).digest('hex'),crypto.createHash('sha256').update(bytes).digest('hex'));
 const saved=new Map();let downloads=0;
 for(const [item,pdf] of [[first,bytes],[second,regenerated]]){
  const key=JSON.stringify(tuple(item));
  const reservation=saved.get(key)||{document_id:docId,document:{id:docId,file_status:'pending'}};
  const decision=runtime.decideReservation(item,reservation);
  if(!decision.skip){downloads++;runtime.decodeHopelabOriginal(pdf,response,decision,cfg);saved.set(key,{document_id:docId,document:{id:docId,file_status:'saved'}});}
 }
 assert.equal(downloads,1);assert.equal(saved.size,1);
});

test('download requires prior reservation, bound URL, status200, PDF MIME and exact observed bytes',()=>{
 assert.equal(runtime.decodeHopelabOriginal(bytes,{...response,headers:{'Content-Type':'application/pdf; charset=binary'}},reserved(),cfg).bytes,bytes);
 for(const statusCode of [301,302,403,404,500])assert.throws(()=>runtime.decodeHopelabOriginal(bytes,{...response,statusCode},reserved(),cfg),/http_response/);
 for(const contentType of ['text/html','application/zip','application/octet-stream'])assert.throws(()=>runtime.decodeHopelabOriginal(bytes,{...response,headers:{'content-type':contentType}},reserved(),cfg),/mime/);
 assert.throws(()=>runtime.decodeHopelabOriginal(bytes,response,origin(),cfg),/not_reserved/);
 const bad=reserved();bad.attachment.downloadUrl=url.replace('/1234/','/9876/');assert.throws(()=>runtime.decodeHopelabOriginal(bytes,response,bad,cfg),/url_mismatch/);
 assert.throws(()=>runtime.decodeHopelabOriginal(Buffer.from('<html>not a pdf</html>'),response,reserved(),cfg),/signature/);
 assert.throws(()=>runtime.decodeHopelabOriginal(bytes,response,reserved(),{...cfg,maxBytes:bytes.length-1}),/size/);
});

test('generated flow reserves both source types before GET, has no remote credentials and rejoins the existing hash/Drive path',async()=>{
 const {intake:w}=await buildWorkflows(),n=name=>w.nodes.find(node=>node.name===name);
 assert.equal(w.nodes.length,50);
 assert.equal(w.connections['Enumerar anexos e ausência'].main[0][0].node,'Aviso Hopelab autorizado');
 assert.equal(w.connections['Aviso Hopelab autorizado'].main[1][0].node,'PDF ou aviso disponível');
 assert.equal(w.connections['Extrair link Hopelab autorizado'].main[0][0].node,'PDF ou aviso disponível');
 assert.equal(w.connections['Um anexo por vez'].main[1][0].node,'Reservar origem');
 assert.equal(w.connections['Precisa baixar'].main[0][0].node,'Origem de link Hopelab');
 assert.equal(w.connections['Origem de link Hopelab'].main[1][0].node,'Gmail - baixar PDF reservado');
 assert.equal(w.connections['Hopelab - baixar PDF reservado'].main[0][0].node,'Validar bytes e SHA-256');
 assert.equal(w.connections['Hopelab - baixar PDF reservado'].main[1][0].node,'Registrar falha de origem');
 const download=n('Hopelab - baixar PDF reservado');assert.equal(download.credentials,undefined);assert.equal(download.parameters.authentication,undefined);assert.equal(download.retryOnFail,false);assert.equal(download.parameters.options.redirect.redirect.followRedirects,false);assert.equal(download.parameters.options.response.response.fullResponse,true);
 assert.equal(n('Gmail - corpo do aviso Hopelab').credentials.oAuth2Api.id,'SELECT_GMAIL_OAUTH');
 const run=async(name,json,outputs={},binaryBytes=bytes)=>new vm.Script('(async function(){'+n(name).parameters.jsCode+'}).call(this)').runInNewContext({Buffer,require:()=>crypto,$json:json,$:name=>({first:()=>({json:cfg}),item:{json:outputs[name]}}),helpers:{getBinaryDataBuffer:async()=>binaryBytes,prepareBinaryData:async(b,name,mime)=>({bytes:Buffer.from(b),fileName:name,mimeType:mime})}});
 const enumerated=await run('Enumerar anexos e ausência',meta,{'Mensagem disponível':{id:meta.id}});assert.equal(enumerated[0].json.hopelabNotice.id,meta.id);
 const links=await run('Extrair link Hopelab autorizado',body(),{'Aviso Hopelab autorizado':enumerated[0].json});assert.equal(links.length,1);assert.equal(links[0].json.resetAttachments,true);
 const output=await run('Validar bytes e SHA-256',response,{'Decidir recebimento':reserved()});assert.equal(output[0].json.sizeBytes,bytes.length);assert.equal(output[0].binary.data.mimeType,'application/pdf');
});
