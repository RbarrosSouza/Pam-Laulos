import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const clone=x=>structuredClone(x);
const inside=p=>{const r=path.relative(root,path.resolve(p));return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
const id=name=>{let s=crypto.createHash('sha256').update('outlook-prospective-child:'+name).digest('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-5${s.slice(13,16)}-a${s.slice(17,20)}-${s.slice(20,32)}`;};
export async function buildOutlookChild({gmail,diagnostic}){
 if(!gmail?.nodes||!diagnostic?.nodes)throw Error('Current private exports required');
 const get=(w,name)=>{const n=w.nodes.find(x=>x.name===name);if(!n)throw Error('Missing node '+name);return clone(n);};
 const kept=['Configuração','Drive - conferir pasta privada','Validar pasta privada','Reservar origem','Decidir recebimento','Precisa baixar','Validar bytes e SHA-256','Original baixado e validado','Drive - gerar ID de arquivo','Reservar ID e upload Drive','Upload reservado','Drive - consultar ID reservado','Validar estado do objeto','Metadados ausentes','Drive - criar metadados com ID fixo','Restaurar contexto Drive','Objeto já tem bytes','Drive - gravar bytes no ID fixo','Drive - conferir bytes salvos','Conferir integridade do original','Confirmar armazenamento','Validar confirmação salva','Registrar falha de origem','Manter janela para recuperação','Adiar sweep quando upload pendente'];
 const nodes=kept.map(n=>get(gmail,n)), byName=new Map(nodes.map(n=>[n.name,n]));
 const add=(name,type,parameters,extra={})=>{let n={id:id(name),name,type:'n8n-nodes-base.'+type,typeVersion:type==='executeWorkflowTrigger'?1.1:2,position:[0,0],parameters,...extra};nodes.push(n);byName.set(name,n);return n;};
 add('Receber anexo Outlook','executeWorkflowTrigger',{inputSource:'passthrough'});
 const prepare=add('Configuração e trava manual','code',{jsCode:`
const item=$('Receber anexo Outlook').first().json;const job=item.job,receipt=item.receipt,ack=item.ack,event=item.event;
const valid=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\\x00-\\x1f\\x7f]/.test(v);
if(!job||!receipt||!ack||!event||ack.recorded!==true||ack.sweep_id!==item.sweep_id||ack.receipt_id!==receipt.receipt_id||job.receipt_id!==receipt.receipt_id
 ||job.source?.channel!=='email'||job.source?.metadata?.provider!=='outlook'||!String(job.source?.account_id||'').startsWith('outlook:')
 ||job.source.account_id!==receipt.account_id||job.source.message_id!==receipt.message_id||job.source.attachment_id!==receipt.attachment_id
 ||job.folder_id!==receipt.partition_key||job.message_id!==receipt.message_id||('outlook-attachment:'+job.attachment_id)!==receipt.attachment_id
 ||event.kind!=='origin_outcome'||event.disposition!=='pending'||event.partition_key!==receipt.partition_key||event.message_id!==receipt.message_id||event.attachment_id!==receipt.attachment_id
 ||receipt.artifact_kind!=='attachment'||![job.folder_id,job.message_id,job.attachment_id].every(valid))throw Error('OUTLOOK_RECEIPT_NOT_PROVEN');
const cfg={mailbox:job.source.account_id.slice('outlook:'.length),messageId:job.message_id,attachmentId:job.attachment_id,folderId:job.folder_id};
return [{json:{cfg,search_input:{queries:['Outlook list attachments of a single email message','Outlook retrieve content bytes for a single attachment in a message in a mail folder','Outlook get message metadata by immutable identifier to find its current parent folder'].map(use_case=>({use_case,known_fields:'mailbox:'+cfg.mailbox})),search_strategy:'tool_search',session:{generate_id:true}}}}];`});
 for(const name of ['Composio - descobrir ferramentas','Validar descoberta e sessão','Composio - listar conexões','Validar conta e preparar leitura','Outlook - listar metadados do anexo','Confirmar parte exata antes de baixar','Outlook - obter bytes do anexo exato']){let n=get(diagnostic,name);n.id=id(name);nodes.push(n);byName.set(name,n);}
 const discovery=byName.get('Validar descoberta e sessão'),returnMarker='return [{json:{session_id:id, list_input:';
 if(!discovery.parameters.jsCode.includes(returnMarker))throw Error('Unsupported Composio discovery validation');
 discovery.parameters.jsCode=discovery.parameters.jsCode.replace(returnMarker,"const available=new Set(data.results.flatMap(r=>[...(r.primary_tool_slugs||[]),...(r.related_tool_slugs||[])]));for(const slug of ['OUTLOOK_GET_MESSAGE','OUTLOOK_LIST_OUTLOOK_ATTACHMENTS','OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS'])if(!available.has(slug))throw Error('OUTLOOK_REQUIRED_TOOL_UNAVAILABLE');\n"+returnMarker);
 const sourceCode=get(diagnostic,'Conferir PDF e hash sem exibir conteúdo').parameters.jsCode;
 const prefix=sourceCode.slice(0,sourceCode.indexOf("const crypto=require('crypto');"));if(!prefix.includes('function parseMcp'))throw Error('Unsupported Composio parser');
 const account=byName.get('Validar conta e preparar leitura');const marker="tools:[{tool_slug:'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS'";
 const from=account.parameters.jsCode.indexOf(marker);if(from<0)throw Error('Unsupported account tool preparation');
 account.parameters.jsCode=account.parameters.jsCode.slice(0,from)+"tools:[{tool_slug:'OUTLOOK_GET_MESSAGE',account:candidates[0].id,arguments:{message_id:$('Configuração e trava manual').first().json.cfg.messageId,user_id:'me',select:['id','parentFolderId']}}]}}}];";
 const locate=get(diagnostic,'Outlook - obter bytes do anexo exato');locate.id=id('Outlook - localizar mensagem');locate.name='Outlook - localizar mensagem';nodes.push(locate);byName.set(locate.name,locate);
 add('Validar mensagem atual','code',{jsCode:prefix+`
const result=parseMcp($input.first().json,'Mensagem');const row=result.results?.[0];const body=row?.response?.data?.response_data||row?.response?.data;
const cfg=$('Configuração e trava manual').first().json.cfg,previous=$('Validar conta e preparar leitura').first().json;
if(row?.tool_slug!=='OUTLOOK_GET_MESSAGE'||row?.response?.successful!==true||body?.id!==cfg.messageId||typeof body.parentFolderId!=='string'||!body.parentFolderId||/[\\x00-\\x1f\\x7f]/.test(body.parentFolderId))throw Error('OUTLOOK_CURRENT_FOLDER_UNPROVEN');
return [{json:{folderId:body.parentFolderId,execute_input:{session_id:previous.session_id,current_step:'READING_OUTLOOK_ATTACHMENT',sync_response_to_workbench:false,tools:[{tool_slug:'OUTLOOK_LIST_OUTLOOK_ATTACHMENTS',account:previous.account,arguments:{message_id:cfg.messageId,user_id:'me',top:100,response_detail:'minimal'}}]}}}];`});
 const choose=byName.get('Confirmar parte exata antes de baixar');const old='mail_folder_id:cfg.folderId';if(!choose.parameters.jsCode.includes(old))throw Error('Unsupported Outlook attachment selector');choose.parameters.jsCode=choose.parameters.jsCode.replace(old,"mail_folder_id:$('Validar mensagem atual').first().json.folderId");
 add('Validar conteúdo Outlook','code',{jsCode:prefix+`
const crypto=require('crypto'),data=parseMcp($input.first().json,'Arquivo');
if(!Array.isArray(data.results)||data.results.length!==1||data.results[0]?.tool_slug!=='OUTLOOK_GET_USER_MESSAGES_ATTACHMENTS'||data.results[0]?.response?.successful!==true)throw Error('OUTLOOK_DOWNLOAD_UNPROVEN');
const file=data.results[0].response.data,cfg=$('Configuração e trava manual').first().json.cfg,expected=$('Confirmar parte exata antes de baixar').first().json.expected_size;
if(!isObject(file)||file.id!==cfg.attachmentId||file['@odata.type']!=='#microsoft.graph.fileAttachment'||file.size!==expected||typeof file.contentBytes!=='string')throw Error('OUTLOOK_IDENTITY_OR_METADATA_INVALID');
const encoded=file.contentBytes,max=$('Configuração').first().json.maxBytes;
if(!Number.isSafeInteger(max)||max<1||max>20971520||encoded.length>Math.ceil(max/3)*4+4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('OUTLOOK_BASE64_INVALID');
const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>max||bytes.toString('base64')!==encoded)throw Error('OUTLOOK_BYTES_INVALID');
if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('OUTLOOK_NON_PDF_REVIEW');
if(!bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF')))throw Error('OUTLOOK_PDF_INVALID');
const job=JSON.parse(JSON.stringify($('Receber anexo Outlook').first().json.job));job.source.metadata.provider_size=expected;job.source.metadata.decoded_size=bytes.length;job.source.metadata.provider_size_differs=expected!==bytes.length;
job.source.mime_type='application/pdf';job.sha256=crypto.createHash('sha256').update(bytes).digest('hex');job.sizeBytes=bytes.length;job.folderId=$('Configuração').first().json.driveFolderId;job.missing=false;
return [{json:job,binary:{data:await this.helpers.prepareBinaryData(bytes,job.source.original_name||'original.pdf','application/pdf')}}];`},{onError:'continueErrorOutput'});
 add('Um anexo por vez','code',{jsCode:'return $input.all();'});
 byName.get('Validar bytes e SHA-256').parameters.jsCode="const origin=$('Decidir recebimento').item.json;const content=$('Validar conteúdo Outlook').item;return [{json:{...origin,sha256:content.json.sha256,sizeBytes:content.json.sizeBytes,folderId:content.json.folderId},binary:content.binary}];";
 byName.get('Registrar falha de origem').parameters.jsonBody=byName.get('Registrar falha de origem').parameters.jsonBody.replace('original Gmail/Drive','original Outlook/Drive');
 byName.get('Manter janela para recuperação').parameters.jsCode="return [{json:{pending:true,recovery:'retry_exact_outlook_source',document_id:$('Decidir recebimento').item.json.documentId}}];";
 add('Origem já salva','code',{jsCode:"const origin=$('Decidir recebimento').item.json;return [{json:{pending:origin.reservation?.document?.file_status!=='saved',document_id:origin.documentId,already_saved:origin.reservation?.document?.file_status==='saved'}}];"});
 add('Erro antes da reserva','code',{jsCode:"const job=$('Receber anexo Outlook').first().json.job;const error=String($json.error?.message||$json.message||'');return [{json:{pending:true,receipt_id:job.receipt_id,reason:error.includes('OUTLOOK_NON_PDF_REVIEW')?'outlook_non_pdf_review':'outlook_attachment_or_reservation_failed'}}];"});
 const connections={};const connect=(from,branches)=>{connections[from]={main:branches.map(v=>v.map(node=>({node,type:'main',index:0})))};};
 const path=['Receber anexo Outlook','Configuração','Drive - conferir pasta privada','Validar pasta privada','Configuração e trava manual','Composio - descobrir ferramentas','Validar descoberta e sessão','Composio - listar conexões','Validar conta e preparar leitura','Outlook - localizar mensagem','Validar mensagem atual','Outlook - listar metadados do anexo','Confirmar parte exata antes de baixar','Outlook - obter bytes do anexo exato','Validar conteúdo Outlook','Um anexo por vez','Reservar origem','Decidir recebimento','Precisa baixar'];
 for(let i=0;i<path.length-1;i++)connect(path[i],[[path[i+1]]]);
 for(const [from,c] of Object.entries(gmail.connections))if(kept.includes(from)&&!path.includes(from))connections[from]=clone(c);
 connect('Precisa baixar',[['Validar bytes e SHA-256'],['Origem já salva']]);
 connect('Validar conteúdo Outlook',[['Um anexo por vez'],['Erro antes da reserva']]);
 connect('Reservar origem',[['Decidir recebimento'],['Erro antes da reserva']]);
 connect('Decidir recebimento',[['Precisa baixar'],['Erro antes da reserva']]);
 connect('Validar confirmação salva',[[],['Manter janela para recuperação']]);
 connect('Manter janela para recuperação',[[]]);connect('Adiar sweep quando upload pendente',[[]]);
 for(const n of nodes)if(['Configuração','Drive - conferir pasta privada','Validar pasta privada','Configuração e trava manual','Composio - descobrir ferramentas','Validar descoberta e sessão','Composio - listar conexões','Validar conta e preparar leitura','Outlook - localizar mensagem','Validar mensagem atual','Outlook - listar metadados do anexo','Confirmar parte exata antes de baixar','Outlook - obter bytes do anexo exato'].includes(n.name)){n.onError='continueErrorOutput';const previous=connections[n.name]||{main:[[]]};previous.main[1]=[{node:'Erro antes da reserva',type:'main',index:0}];connections[n.name]=previous;}
 // Configured node names used in expressions are retained. Do not expose provider
 // payloads in execution history; child returns only completion/identity metadata.
 const names=new Set(nodes.map(n=>n.name));for(const [from,c] of Object.entries(connections))for(const branch of c.main||[])for(const edge of branch)if(!names.has(edge.node))throw Error('Dangling node '+from+' -> '+edge.node);
 nodes.forEach((n,i)=>n.position=[(i%8)*240,Math.floor(i/8)*210]);
 return {name:'OUTLOOK — preservar anexo prospectivo (INATIVO)',active:false,nodes,connections,settings:{executionOrder:'v1',saveDataSuccessExecution:'none',saveDataErrorExecution:'none',saveManualExecutions:false,saveExecutionProgress:false},pinData:{}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,x)=>i%2?a:[...a,[v,x[i+1]]],[]));const a=args['--gmail'],b=args['--diagnostic'],out=args['--out'];if(!a||!b||!out||[a,b,out].some(inside))throw Error('Supply external private --gmail, --diagnostic, --out paths');
 const w=await buildOutlookChild({gmail:JSON.parse(await fs.readFile(a,'utf8')),diagnostic:JSON.parse(await fs.readFile(b,'utf8'))});await fs.mkdir(path.dirname(out),{recursive:true,mode:0o700});await fs.writeFile(out,JSON.stringify(w,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({created:true,active:w.active,nodes:w.nodes.length,sha256:crypto.createHash('sha256').update(JSON.stringify(w)).digest('hex')}));
}
