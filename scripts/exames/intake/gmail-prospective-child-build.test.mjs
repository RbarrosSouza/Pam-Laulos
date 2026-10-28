import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import vm from 'node:vm';
import {buildProspectiveGmailChild} from './gmail-prospective-child-build.mjs';
import {inspectMessage,decodeOriginal,fail,object,stableId,unwrap,validateWindow,header,senderAddress} from '../operacional-runtime.mjs';
const cutoff='2026-10-28T10:00:00.000Z',collector='gmail_prospective_'+crypto.createHash('sha256').update(cutoff).digest('hex').slice(0,16);
const oldCfg={enabled:true,mailbox:'synthetic@example.invalid',intakeCutoff:'2026-10-01T00:00:00.000Z',manualMessageId:'',includeSpamTrash:false};
const legacy="if(cfg.manualMessageId&&$execution.mode!=='test')throw new Error('Seleção de mensagem só pode ser usada manualmente');";
const node=(name,type,parameters={})=>({name,type,id:crypto.randomUUID(),position:[0,0],parameters});
const source=()=>({nodes:[node('Configuração','n8n-nodes-base.code',{jsCode:'const cfg='+JSON.stringify(oldCfg)+';\nif(!cfg.enabled)throw Error("paused");\n'+legacy+'\nreturn [{json:cfg}];'}),
  node('Extrair link Hopelab autorizado','n8n-nodes-base.code',{jsCode:'// applyHopelabNoticeV2Policy'}),node('Decidir recebimento','n8n-nodes-base.code',{jsCode:'// verifyHopelabNoticeV2Reservation'}),
  node('Enumerar anexos e ausência','n8n-nodes-base.code',{jsCode:inspectMessage.toString()}),node('Validar bytes e SHA-256','n8n-nodes-base.code',{jsCode:decodeOriginal.toString()}),
  node('Gmail - MIME sem bytes','n8n-nodes-base.httpRequest',{url:'fixture'}),node('Origem de link Hopelab','n8n-nodes-base.if'),
  node('PDF ou aviso disponível','n8n-nodes-base.if'),
  node('Marcar mensagem excluída','n8n-nodes-base.code',{jsCode:'return [];'}),
  node('Registrar falha de origem','n8n-nodes-base.httpRequest',{jsonBody:'fixture'}),
  node('Reconciliar reservas vencidas','n8n-nodes-base.httpRequest'),node('Gmail - conferir conta OAuth','n8n-nodes-base.httpRequest'),
  node('agenda','n8n-nodes-base.scheduleTrigger'),node('manual','n8n-nodes-base.manualTrigger')],connections:{'Origem de link Hopelab':{main:[[],[]]},'PDF ou aviso disponível':{main:[[],[]]}},settings:{}});

test('child restricts to one prospective identity and excludes all independent triggers and global reconcile',async()=>{
  const child=buildProspectiveGmailChild(source(),cutoff,collector);assert.equal(child.active,false);
  assert.equal(child.nodes.filter(n=>n.type.endsWith('.executeWorkflowTrigger')).length,1);
  assert(!child.nodes.some(n=>/scheduleTrigger|manualTrigger/.test(n.type)||n.name==='Reconciliar reservas vencidas'));
  assert.equal(child.connections['Configuração'].main[0][0].node,'Gmail - conferir conta OAuth');
  const code=child.nodes.find(n=>n.name==='Configuração').parameters.jsCode,script=new vm.Script('(async()=>{'+code+'})()');
  const invoke=payload=>script.runInNewContext({$input:{all:()=>[{json:{payload}}]},$execution:{mode:'trigger'}});
  const request={message_id:'abcdef01',account_id:'gmail:synthetic@example.invalid',collector_id:collector,cutoff,targets:[{kind:'gmail_part',part_id:'3'}]};
  const result=await invoke(request);assert.equal(result[0].json.manualMessageId,'abcdef01');assert.equal(result[0].json.intakeCutoff,cutoff);assert.equal(result[0].json.includeSpamTrash,true);
  await assert.rejects(invoke({...request,cutoff:'2026-10-01T00:00:00.000Z'}),/BRIDGE_INPUT_IDENTITY_INVALID/);
  await assert.rejects(invoke({...request,account_id:'gmail:wrong@example.invalid'}),/BRIDGE_INPUT_IDENTITY_INVALID/);
  await assert.rejects(invoke({...request,message_id:'not-an-id'}),/BRIDGE_INPUT_IDENTITY_INVALID/);
  await assert.rejects(invoke({...request,targets:[]}),/BRIDGE_TARGETS_INVALID/);
});

test('child refuses old OP01 snapshots without HopeLab notice and backend hold safeguards',()=>{
  const old=source();old.nodes.find(n=>n.name==='Decidir recebimento').parameters.jsCode='';
  assert.throws(()=>buildProspectiveGmailChild(old,cutoff,collector),/Hopelab snapshot guard/);
  assert.throws(()=>buildProspectiveGmailChild(source(),cutoff,'gmail_audit_v2'),/Collector and cutoff/);
});

test('anonymous octet-stream and inline PDF require original bytes, matching part and PDF signature',async()=>{
  const child=buildProspectiveGmailChild(source(),cutoff,collector),sandbox={fail,object,stableId,unwrap,validateWindow,header,senderAddress,EXPECTED_MAILBOX:'exames@example.invalid',MAX_MIME_DEPTH:8,MAX_BYTES:20971520,Buffer,crypto};
  const inspect=new vm.Script('(function(){'+child.nodes.find(n=>n.name==='Enumerar anexos e ausência').parameters.jsCode+';return inspectMessage;})()').runInNewContext(sandbox);
  const cfg={mailbox:'exames@example.invalid',intakeCutoff:cutoff,windowStart:cutoff,sweepEnd:'2026-10-29T10:00:00.000Z',allowedSenders:[],examSubjectHints:[]};
  const bytes=Buffer.from('%PDF-1.4\nfixture'),mid='abcdef01',part={partId:'0',mimeType:'application/octet-stream',filename:'',body:{size:bytes.length}};
  const metadata={id:mid,internalDate:String(Date.parse('2026-10-28T12:00:00Z')),payload:{...part,headers:[]}};
  const origin=inspect(metadata,mid,cfg).origins[0];assert.equal(origin.attachment.partId,'0');assert.equal(origin.missing,false);assert.equal(origin.source.original_name,'original.pdf');
  const selectedCode=child.nodes.find(n=>n.name==='Selecionar bytes pela parte exata').parameters.jsCode;
  const selectedScript=new vm.Script('(async()=>{'+selectedCode+'})()');
  const selected=await selectedScript.runInNewContext({$json:{id:mid,payload:{...part,body:{...part.body,data:bytes.toString('base64url')}}},$:()=>({item:{json:origin}})});
  assert.equal(selected[0].json.data,bytes.toString('base64url'));
  const bad=selectedScript.runInNewContext({$json:{id:'abcdef02',payload:part},$:()=>({item:{json:origin}})});await assert.rejects(bad,/INLINE_MESSAGE_IDENTITY_UNPROVEN/);
  const decoder=new vm.Script('(function(){'+child.nodes.find(n=>n.name==='Validar bytes e SHA-256').parameters.jsCode+';return decodeOriginal;})()').runInNewContext(sandbox);
  const decoded=decoder(selected[0].json,{...origin,documentId:'fixture-document'}, {...cfg,driveFolderId:'fixture-folder'});
  assert.equal(decoded.json.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  const notPdf=Buffer.alloc(bytes.length,0);assert.throws(()=>decoder({data:notPdf.toString('base64url'),size:notPdf.length},{...origin,documentId:'fixture-document'},{...cfg,driveFolderId:'fixture-folder'}),/gmail_pdf_signature_missing/);
  const expression=child.nodes.find(n=>n.name==='Registrar falha de origem').parameters.jsonBody;
  const evaluate=error=>new vm.Script(expression.slice(3,-3).trim()).runInNewContext({$json:{error:{message:error}},$:()=>({item:{json:{documentId:'fixture-document'}}})});
  const signatureError=evaluate('gmail_pdf_signature_missing');assert.match(signatureError.payload.review_reason,/assinatura PDF/);
  assert(!JSON.stringify(evaluate('provider-secret-text')).includes('provider-secret-text'));
});

test('actual child selector sends only the fourth pending part to reservation among four unnamed PDFs',async()=>{
  const child=buildProspectiveGmailChild(source(),cutoff,collector),sandbox={fail,object,stableId,unwrap,validateWindow,header,senderAddress,EXPECTED_MAILBOX:'exames@example.invalid',MAX_MIME_DEPTH:8,MAX_BYTES:20971520};
  const inspect=new vm.Script('(function(){'+child.nodes.find(n=>n.name==='Enumerar anexos e ausência').parameters.jsCode+';return inspectMessage;})()').runInNewContext(sandbox);
  const cfg={mailbox:'exames@example.invalid',intakeCutoff:cutoff,windowStart:cutoff,sweepEnd:'2026-10-29T10:00:00.000Z',allowedSenders:[],examSubjectHints:[]};
  const message={id:'abcdef01',internalDate:String(Date.parse('2026-10-28T12:00:00Z')),payload:{partId:'',mimeType:'multipart/mixed',headers:[],
    parts:Array.from({length:4},(_,i)=>({partId:String(i),mimeType:'application/pdf',filename:'',body:{attachmentId:'locator-'+i,size:100}}))}};
  const all=inspect(message,message.id,cfg).origins.map(json=>({json}));assert.equal(all.length,4);
  const code=child.nodes.find(n=>n.name==='Selecionar somente origens pendentes').parameters.jsCode;
  const select=new vm.Script('(async()=>{'+code+'})()');
  const selected=await select.runInNewContext({$input:{all:()=>all},$:()=>({first:()=>({json:{bridgeTargets:[{kind:'gmail_part',part_id:'3'}]}})})});
  assert.equal(selected.length,1);assert.equal(selected[0].json.source.metadata.gmail_part_id,'3');assert.equal(selected[0].json.messageAttachmentCount,1);
  assert(!selected.some(item=>['0','1','2'].includes(item.json.source.metadata.gmail_part_id)));
  const missing=await select.runInNewContext({$input:{all:()=>all},$:()=>({first:()=>({json:{bridgeTargets:[{kind:'gmail_part',part_id:'missing'}]}})})});
  assert.equal(missing[0].json.messageExcluded,true);assert.equal(missing[0].json.reason,'target_attachment_not_found');
});
