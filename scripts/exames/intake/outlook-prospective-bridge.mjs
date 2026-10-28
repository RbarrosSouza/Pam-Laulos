import crypto from 'node:crypto';

// Pure bridge for the existing collector state machine. The caller must persist
// every operation before executing the next; this module does not access n8n,
// Composio, the ledger, Drive, or WhatsApp and does not itself prove coverage.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\x00-\x1f\x7f]/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const safeName=v=>typeof v==='string'&&v.length<=512&&!/[\x00-\x1f\x7f/\\]/.test(v)?v:'';

// Individual well-known folders are inputs only after the caller has checked
// actual identities and recursively listed descendants. Sent/drafts/outbox
// and their descendants must be excluded from the incoming-mail manifest.
export function outlookFolderInventory(folders,{excludedRoots=[],topLevelComplete=true,topLevelIds}={}) {
 if(!Array.isArray(folders)||!Array.isArray(excludedRoots)||excludedRoots.some(x=>!id(x))||typeof topLevelComplete!=='boolean')throw Error('OUTLOOK_FOLDER_MANIFEST_INVALID');
 const byId=new Map();
 for(const f of folders){if(!object(f)||!id(f.id)||f.parentFolderId!=null&&!id(f.parentFolderId)||!integer(f.childFolderCount)||byId.has(f.id))throw Error('OUTLOOK_FOLDER_IDENTITY_INVALID');byId.set(f.id,f);}
 for(const root of excludedRoots)if(!byId.has(root))throw Error('OUTLOOK_EXCLUDED_FOLDER_UNPROVEN');
 const roots=topLevelIds??folders.filter(f=>!f.parentFolderId).map(f=>f.id);
 if(!Array.isArray(roots)||roots.some(x=>!id(x)||!byId.has(x))||(!roots.length&&folders.length))throw Error('OUTLOOK_TOP_LEVEL_UNPROVEN');
 function disposition(f){let cur=f;const visited=new Set();while(cur){if(visited.has(cur.id))throw Error('OUTLOOK_FOLDER_CYCLE');visited.add(cur.id);if(excludedRoots.includes(cur.id))return 'excluded';if(roots.includes(cur.id))return 'included';cur=cur.parentFolderId?byId.get(cur.parentFolderId):null;}return 'unproven';}
 const children=new Map();for(const f of folders)if(f.parentFolderId&&byId.has(f.parentFolderId))children.set(f.parentFolderId,(children.get(f.parentFolderId)||0)+1);
 const relevant=[...byId.values()].filter(f=>disposition(f)==='included');
 const unresolved=[...byId.values()].filter(f=>disposition(f)==='unproven').map(f=>({folder_id:f.id,code:'outlook_folder_parent_unproven'}));
 unresolved.push(...relevant.filter(f=>(children.get(f.id)||0)!==f.childFolderCount).map(f=>({folder_id:f.id,code:'outlook_folder_children_incomplete'})));
 if(!topLevelComplete)unresolved.push({folder_id:null,code:'outlook_top_level_incomplete'});
 return {folders:relevant.map(f=>f.id).sort(),unresolved,coverageComplete:unresolved.length===0};
}
export function outlookFolderManifest(folders,options={}) {
 const result=outlookFolderInventory(folders,options);
 if(!result.coverageComplete)throw Error('OUTLOOK_FOLDER_HIERARCHY_INCOMPLETE');
 return result.folders;
}

export function outlookPage({folderId,body,from,through,pageKey,requestCursor=null,mailbox}) {
 if(!id(folderId)||!id(pageKey)||requestCursor!==null&&!id(requestCursor)||!iso(from)||!iso(through)||Date.parse(through)<=Date.parse(from)||!object(body)||!Array.isArray(body.value)||body.value.length>100)throw Error('OUTLOOK_PAGE_INVALID');
 const next=body.next_page_token??null;if(next!==null&&!id(next))throw Error('OUTLOOK_PAGE_CURSOR_INVALID');
 if(body['@odata.nextLink']&&!next)throw Error('OUTLOOK_PAGE_CONTINUATION_UNSUPPORTED');
 const messages=[],seen=new Set();for(const row of body.value){
  if(!object(row)||!id(row.id)||!iso(row.receivedDateTime)||seen.has(row.id))throw Error('OUTLOOK_PAGE_ITEM_INVALID');seen.add(row.id);
  if(Date.parse(row.receivedDateTime)<Date.parse(from)||Date.parse(row.receivedDateTime)>=Date.parse(through))throw Error('OUTLOOK_PAGE_OUTSIDE_WINDOW');
  if(row.parentFolderId!=null&&!id(row.parentFolderId))throw Error('OUTLOOK_PAGE_FOLDER_INVALID');
  const sender=row.from?.emailAddress?.address;
  const directionProven=row.isDraft===false&&typeof mailbox==='string'&&typeof sender==='string'&&/^[^\s@]+@[^\s@]+$/.test(sender)&&sender.toLowerCase()!==mailbox.toLowerCase();
  messages.push({id:row.id,received_at:new Date(row.receivedDateTime).toISOString(),directionProven});
 }
 const event={kind:'page_discovered',partition_key:folderId,page_key:pageKey,page_sha256:hash(JSON.stringify(messages.map(x=>x.id))),message_ids:messages.map(x=>x.id),is_terminal:next===null,
  ...(requestCursor===null?{}:{request_cursor_sha256:hash(requestCursor)}),...(next===null?{}:{next_cursor_sha256:hash(next)})};
 return {event,messages,next_cursor:next};
}

// Detect incompleteness rather than claiming one metadata page is all files.
export function outlookOrigins({folderId,message,attachmentPages,allowIncomplete=false}) {
 if(!id(folderId)||!object(message)||!id(message.id)||!iso(message.received_at)||!Array.isArray(attachmentPages)||!attachmentPages.length)throw Error('OUTLOOK_ATTACHMENTS_INVALID');
 const seen=new Map(), origins=[],dispositions=new Map(),details=[];let expectedSkip=0,inventoryIncomplete=allowIncomplete===true;
 for(let index=0;index<attachmentPages.length;index++){
 const page=attachmentPages[index];if(!object(page)||page.skip!==expectedSkip||!object(page.body)||!Array.isArray(page.body.value)||page.body.value.length>100)throw Error('OUTLOOK_ATTACHMENTS_PAGE_INVALID');
 for(const a of page.body.value){
  if(!object(a)||!id(a.id)){inventoryIncomplete=true;continue;}
  const key='outlook-attachment:'+a.id;
  if(seen.has(key)){inventoryIncomplete=true;dispositions.set(key,{disposition:'failed',stage:'enumeration',code:'outlook_attachment_identity_ambiguous'});continue;}
  seen.set(key,true);origins.push({attachment_id:key,artifact_kind:'attachment'});
  const safe=(v,max)=>typeof v==='string'&&v.trim()&&!/[\x00-\x1f\x7f]/.test(v)&&!v.includes('://')?v.trim().slice(0,max):null;
  details.push({kind:'attachment_details',partition_key:folderId,message_id:message.id,attachment_id:key,received_at:message.received_at,position:origins.length,display_name:safe(a.name,200),mime_type:safe(a.contentType,100),sender:null});
  if(typeof a['@odata.type']!=='string'||a.size!=null&&!integer(a.size))dispositions.set(key,{disposition:'failed',stage:'enumeration',code:'outlook_attachment_metadata_invalid'});
  else if(a['@odata.type']!=='#microsoft.graph.fileAttachment')dispositions.set(key,{disposition:'pending',stage:'review',code:'outlook_attachment_type_review'});
  else if(typeof a.contentType==='string'&&a.contentType&&!['application/pdf','application/octet-stream'].includes(a.contentType.split(';')[0].trim().toLowerCase()))dispositions.set(key,{disposition:'pending',stage:'review',code:'outlook_attachment_format_review'});
 }
 const next=page.body['@odata.nextLink']||null;
 if(next){let url;try{url=new URL(next);}catch{throw Error('OUTLOOK_ATTACHMENT_NEXT_LINK_INVALID');}const skip=url.searchParams.get('$skip');
  if(url.origin!=='https://graph.microsoft.com'||!/^\d{1,8}$/.test(skip||'')||Number(skip)<=expectedSkip||index===attachmentPages.length-1&&!allowIncomplete)throw Error('OUTLOOK_ATTACHMENTS_PAGINATION_REQUIRED');
  expectedSkip=Number(skip);
 }else if(index!==attachmentPages.length-1)throw Error('OUTLOOK_ATTACHMENTS_UNEXPECTED_PAGE');
 else if(page.body.value.length===100&&!allowIncomplete)throw Error('OUTLOOK_ATTACHMENTS_TERMINAL_UNPROVEN');
 }
 if(origins.length>200)throw Error('OUTLOOK_ATTACHMENT_LIMIT_REQUIRES_REVIEW');
 if(origins.length>200)throw Error('OUTLOOK_ATTACHMENT_LIMIT_REQUIRES_REVIEW');
 // No attachment does not prove the absence of a clinical link in the body.
 // Keep a durable notice pending until content is classified or reviewed.
 if(!origins.length&&!inventoryIncomplete)origins.push({attachment_id:'outlook-notice:metadata-only',artifact_kind:'notice'});
 return {inventoryIncomplete,message_event:{kind:'message_discovered',partition_key:folderId,message_id:message.id,received_at:message.received_at},
  origins_event:origins.length?{kind:'origins_declared',partition_key:folderId,message_id:message.id,origins}:null,
  details,outcomes:origins.map(a=>({kind:'origin_outcome',partition_key:folderId,message_id:message.id,attachment_id:a.attachment_id,...(dispositions.get(a.attachment_id)||{disposition:'pending',stage:a.artifact_kind==='notice'?'review':'storage',code:a.artifact_kind==='notice'?'outlook_message_content_unclassified':message.directionProven===false?'outlook_direction_review_required':'outlook_attachment_unprocessed'})}))};
}

// Only after both message and per-origin durable ACKs, fetch the exact part.
export function outlookAttachmentJob({accountId,folderId,message,metadata,sweepId,event,ack,receipt}) {
 if(!id(accountId)||!accountId.startsWith('outlook:')||!id(folderId)||!object(message)||!id(message.id)||!iso(message.received_at)||!object(metadata)||!id(metadata.id)||!id(sweepId)||
  !object(event)||event.kind!=='origin_outcome'||event.disposition!=='pending'||event.attachment_id!=='outlook-attachment:'+metadata.id||event.message_id!==message.id||event.partition_key!==folderId||
  !object(ack)||ack.recorded!==true||ack.sweep_id!==sweepId||!id(ack.receipt_id)||
  !object(receipt)||receipt.receipt_id!==ack.receipt_id||receipt.account_id!==accountId||receipt.partition_key!==folderId||receipt.message_id!==message.id||receipt.attachment_id!==event.attachment_id||receipt.artifact_kind!=='attachment')
  throw Error('OUTLOOK_LEDGER_ACK_UNPROVEN');
 if(metadata['@odata.type']!=='#microsoft.graph.fileAttachment')throw Error('OUTLOOK_ATTACHMENT_TYPE_REVIEW');
 if(metadata.size!=null&&!integer(metadata.size))throw Error('OUTLOOK_ATTACHMENT_SIZE_INVALID');
 const name=safeName(metadata.name)||'original.pdf';
 return {receipt_id:ack.receipt_id,folder_id:folderId,message_id:message.id,attachment_id:metadata.id,listed_size:metadata.size??null,
  source:{channel:'email',account_id:accountId,message_id:message.id,attachment_id:'outlook-attachment:'+metadata.id,original_name:name,mime_type:typeof metadata.contentType==='string'?metadata.contentType:'application/octet-stream',received_at:message.received_at,
   metadata:{provider:'outlook',outlook_folder_id:folderId,outlook_message_id:message.id,outlook_attachment_id:metadata.id,unknown_sender:true,exam_candidate:false}}};
}

export function outlookAttachmentBytes({job,response,maxBytes=20971520}) {
 if(!object(job)||!id(job.receipt_id)||!id(job.message_id)||!id(job.attachment_id)||!object(response)||response.id!==job.attachment_id||response['@odata.type']!=='#microsoft.graph.fileAttachment'||
  !Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>20971520||typeof response.contentBytes!=='string'||response.contentBytes.length>Math.ceil(maxBytes/3)*4+4)
  throw Error('OUTLOOK_ATTACHMENT_DOWNLOAD_UNPROVEN');
 const encoded=response.contentBytes;if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('OUTLOOK_ATTACHMENT_BASE64_INVALID');
 const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>maxBytes||bytes.toString('base64')!==encoded)throw Error('OUTLOOK_ATTACHMENT_BYTES_INVALID');
 if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))||!bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF')))throw Error('OUTLOOK_ATTACHMENT_PDF_UNPROVEN');
 if(response.size!=null&&!integer(response.size))throw Error('OUTLOOK_ATTACHMENT_SIZE_INVALID');
 if(job.listed_size!=null&&response.size!=null&&job.listed_size!==response.size)throw Error('OUTLOOK_ATTACHMENT_METADATA_CHANGED');
 // The decoded payload is bound to the provider part and has a stable hash.
 // Preservation still requires Drive readback and a matching hash/byte count;
 // a PDF parser and the clinical classification remain downstream obligations.
 return {bytes,sha256:hash(bytes),size_bytes:bytes.length,provider_size:job.listed_size,provider_size_differs:job.listed_size!==null&&job.listed_size!==bytes.length,
  drive_readback_required:true,clinical_processing_required:true,ready_for_preservation:true};
}
