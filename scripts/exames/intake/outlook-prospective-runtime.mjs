import crypto from 'node:crypto';
import {outlookPage,outlookOrigins,outlookAttachmentJob,outlookFolderInventory} from './outlook-prospective-bridge.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const str=x=>typeof x==='string'&&x.length>0&&x.length<=2048&&!/[\x00-\x1f\x7f]/.test(x);
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
function restoreOutlookPendingDetails(s){
 if(s.phase!=='events'||s.afterEvents!=='jobs'||s.detailsRestored===true||!Array.isArray(s.jobs)||!Array.isArray(s.pendingEvents))return;
 if(s.pendingEvents.some(e=>e.kind==='attachment_details')){s.detailsRestored=true;return;}
 const message=s.messageQueue?.[s.messageIndex];if(!message||!str(message.id)||!Number.isFinite(Date.parse(message.received_at)))return;
 const safe=(v,max)=>typeof v==='string'&&v.trim()&&!/[\x00-\x1f\x7f]/.test(v)&&!v.includes('://')?v.trim().slice(0,max):null;
 const details=s.jobs.flatMap((j,index)=>j.metadata&&j.event?.attachment_id==='outlook-attachment:'+j.metadata.id?[{kind:'attachment_details',partition_key:j.event.partition_key,message_id:j.event.message_id,attachment_id:j.event.attachment_id,received_at:message.received_at,position:index+1,display_name:safe(j.metadata.name,200),mime_type:safe(j.metadata.contentType,100),sender:null}]:[]);
 const at=s.pendingEvents.findIndex(e=>e.kind==='origins_declared');s.pendingEvents.splice(at<0?0:at+1,0,...details);s.detailsRestored=true;
}
export function outlookManifest(c){return {provider:'outlook',account_id:'outlook:'+c.mailbox,scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all',include_spam_trash:false,include_deleted:true,initial_received_from:c.intakeCutoff,lookback_seconds:86400};}
export function validateOutlookConfig(c){if(!c.enabled||typeof c.mailbox!=='string'||!/^[^\s@]+@[^\s@]+$/.test(c.mailbox)||typeof c.collectorId!=='string'||!/^[A-Za-z0-9_.:-]{1,96}$/.test(c.collectorId)||typeof c.serviceUrl!=='string'||!/^https:\/\/[a-z\d.-]+\/functions\/v1\/exam-document-service$/i.test(c.serviceUrl)||!uuid(c.activationId)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.intakeCutoff)||!Number.isFinite(Date.parse(c.intakeCutoff))||c.provider!=='outlook'||!Number.isSafeInteger(c.maxActions)||c.maxActions<1||c.maxActions>200||c.maxMillis!==180000||c.leaseMillis!==900000||typeof c.childWorkflowId!=='string'||!/^[A-Za-z0-9]{8,64}$/.test(c.childWorkflowId))throw Error('OUTLOOK_COLLECTOR_CONFIG_INVALID');return c;}
export function loadOutlookState(rows,c,executionId,now){
 const actual=rows.filter(r=>r&&r.collector_key!==undefined);if(actual.length>1||actual.length&&actual[0].collector_key!==c.collectorId)throw Error('OUTLOOK_COLLECTOR_DUPLICATE_STATE');
 let s=actual.length?JSON.parse(actual[0].state_json):null;const identityHash=digest([outlookManifest(c),c.serviceUrl,c.activationId]);
 if(s&&(s.version!==1||s.identityHash!==identityHash||s.revision!==actual[0].revision))throw Error('OUTLOOK_COLLECTOR_STATE_INVALID');
 if(s&&s.phase!=='done'&&s.lease?.owner&&s.lease.owner!==String(executionId)&&s.lease.until>now)return {...s,busy:true};
 if(s)restoreOutlookPendingDetails(s);
 if(!s||s.phase==='done'){
  const prev=s,progress=prev?.progressThrough?Date.parse(prev.progressThrough):Date.parse(c.intakeCutoff),backfill=prev?.pendingBackfillFrom?Date.parse(prev.pendingBackfillFrom):null;
  // Alternate a retained failed interval with new arrivals regardless of cron
  // jitter; a permanently incomplete folder must not freeze live discovery.
  const replay=backfill!==null&&prev?.replay!==true;
  const start=replay?backfill:Math.max(Date.parse(c.intakeCutoff),progress-300000);
  s={version:1,identityHash,revision:actual[0]?.revision||0,requestId:crypto.randomUUID(),receivedFrom:new Date(start).toISOString(),receivedThrough:new Date(Math.min(now-1000,start+86400000)).toISOString(),phase:'begin',folders:[],rootIds:[],excludedRoots:[],folderQueue:[],folderIndex:0,folderPage:null,folderTokens:[],mailIndex:0,mailCursor:null,mailTokens:[],mailSeen:[],mailPage:0,pages:0,messages:0,pendingEvents:[],jobs:[],jobIndex:0,issues:[],coverageProof:prev?.coverageProof||null,progressThrough:prev?.progressThrough||null,pendingBackfillFrom:prev?.pendingBackfillFrom||null,retryQueue:prev?.retryQueue||[],retryRemaining:Math.min(50,(prev?.retryQueue||[]).length),replay};
 }
 if(Date.parse(s.receivedThrough)<=Date.parse(s.receivedFrom))throw Error('OUTLOOK_COLLECTOR_WINDOW_INVALID');
 if(s.sweepId&&s.phase!=='finish'&&!s.resumeRequest)s.resumeRequest={resumeRequestId:crypto.randomUUID(),runToken:s.runToken};
 s.rowId=actual[0]?.id??null;s.tick={executionId:String(executionId),actions:0,startedAt:now};s.lease={owner:String(executionId),until:now+c.leaseMillis};s.busy=false;s.releaseLease=false;s.halt=false;return s;
}
function enqueue(s,events,after){s.pendingEvents=events;s.afterEvents=after;s.phase='events';return s;}
function eventFor(s,e){return {target:'backend',state:s,action:'intake_event',payload:{sweep_id:s.sweepId,run_token:s.runToken,event:e}};}
function responseBody(r){if(!obj(r)||r.successful!==true||!obj(r.data))throw Error('OUTLOOK_PROVIDER_UNAVAILABLE');return obj(r.data.response_data)?r.data.response_data:r.data;}
export function nextOutlookOperation(input,c,now){let s=copy(input);
 if(s.releaseLease)return {target:'stop',state:s,result:s.finalResult};
 if(s.phase==='done')return {target:'stop',state:s,result:{...s.finishResult,continuationRequired:false,notificationMode:'home_only',issues:s.issues.length}};
 if(s.halt||s.tick.actions>=c.maxActions||now-s.tick.startedAt>c.maxMillis)return {target:'stop',state:s,result:{coverageComplete:false,scanFinished:false,continuationRequired:true,issues:s.issues.length}};
 s.tick.actions++;
 if(s.resumeRequest)return {target:'backend',state:s,action:'intake_resume',payload:{collector_id:c.collectorId,scope_key:digest(outlookManifest(c)),request_id:s.requestId,sweep_id:s.sweepId,run_token:s.resumeRequest.runToken,resume_request_id:s.resumeRequest.resumeRequestId,ttl_seconds:3600}};
 if(s.phase==='begin')return {target:'backend',state:s,action:'intake_begin',payload:{collector_id:c.collectorId,scope_key:digest(outlookManifest(c)),scope_manifest:outlookManifest(c),received_from:s.receivedFrom,received_through:s.receivedThrough,request_id:s.requestId,mode:'audit',ttl_seconds:3600}};
 if(s.phase==='events'){if(!s.pendingEvents.length){s.phase=s.afterEvents;return nextOutlookOperation(s,c,now);}
  const e=s.pendingEvents[0],job=s.jobs?.find(j=>j.event?.attachment_id===e.attachment_id);
  if(e.kind==='origin_outcome'&&job?.metadata&&s.outcomeChecked!==e.attachment_id){s.outcomeLookup=e;return {target:'backend',state:s,action:'intake_lookup_source',payload:{collector_id:c.collectorId,identities:[{account_id:'outlook:'+c.mailbox,partition_key:e.partition_key,message_id:e.message_id,attachment_id:e.attachment_id}]}};}
  return eventFor(s,e);}
 if(s.phase==='advance_job'){s.jobIndex++;s.phase='jobs';return nextOutlookOperation(s,c,now);}
 if(s.phase==='halt_before_retry'){s.phase=s.retryPhase;delete s.retryPhase;s.halt=true;return nextOutlookOperation(s,c,now);}
 if(s.phase==='retry_jobs'){
  if(!s.retryRemaining||!s.retryQueue.length){s.phase='folder_roots';return nextOutlookOperation(s,c,now);}
  const j=s.retryQueue[0],e=j.event,receipt={receipt_id:j.ack.receipt_id,account_id:'outlook:'+c.mailbox,partition_key:e.partition_key,message_id:e.message_id,attachment_id:e.attachment_id,artifact_kind:'attachment'};
  const job=outlookAttachmentJob({accountId:receipt.account_id,folderId:e.partition_key,message:j.message,metadata:j.metadata,sweepId:j.sweepId,event:e,ack:j.ack,receipt});
  return {target:'child',state:s,payload:{job,receipt,event:e,ack:j.ack,sweep_id:j.sweepId}};
 }
 if(s.phase==='folder_roots')return {target:'provider',state:s,slug:'OUTLOOK_LIST_MAIL_FOLDERS',args:{user_id:'me',top:100,include_hidden_folders:true,select:['id','parentFolderId','childFolderCount'],...(s.folderPage?{page_token:s.folderPage}:{})}};
 if(s.phase==='folder_excludes')return {target:'provider',state:s,slug:'OUTLOOK_GET_MAIL_FOLDER',args:{user_id:'me',mail_folder_id:['sentitems','drafts','outbox'][s.excludeIndex],select:['id','parentFolderId','childFolderCount']}};
 if(s.phase==='folder_children'){
  if(s.folderIndex>=s.folderQueue.length){const inventory=outlookFolderInventory(s.folders,{topLevelIds:s.rootIds,excludedRoots:s.excludedRoots,topLevelComplete:true});s.scanFolders=inventory.folders;s.mailIndex=0;
   if(inventory.unresolved.length){s.issues.push(...inventory.unresolved);return nextOutlookOperation(enqueue(s,inventory.unresolved.map(v=>({kind:'failure',partition_key:v.folder_id||'folders',stage:'enumeration',code:v.code})),'mail_page'),c,now);}s.phase='mail_page';return nextOutlookOperation(s,c,now);}
  return {target:'provider',state:s,slug:'OUTLOOK_LIST_CHILD_MAIL_FOLDERS',args:{user_id:'me',parent_folder_id:s.folderQueue[s.folderIndex],top:100,include_hidden_folders:true,select:['id','parentFolderId','childFolderCount'],...(s.folderPage?{page_token:s.folderPage}:{})}};
 }
 if(s.phase==='mail_page'){
  if(s.mailIndex>=s.scanFolders.length){s.phase=s.issues.length?'finish':'enumeration';return nextOutlookOperation(s,c,now);}
  return {target:'provider',state:s,slug:'OUTLOOK_QUERY_EMAILS',args:{folder:s.scanFolders[s.mailIndex],top:100,user_id:'me',select:['id','receivedDateTime','parentFolderId','from','isDraft'],filter:'receivedDateTime ge '+s.receivedFrom+' and receivedDateTime lt '+s.receivedThrough,orderby:'receivedDateTime asc',...(s.mailCursor?{page_token:s.mailCursor}:{})}};
 }
 if(s.phase==='messages'){
  if(s.messageIndex>=s.messageQueue.length){if(s.nextMailCursor){s.mailCursor=s.nextMailCursor;s.mailPage++;}else{s.mailIndex++;s.mailCursor=null;s.mailPage=0;s.mailTokens=[];s.mailSeen=[];}s.phase='mail_page';return nextOutlookOperation(s,c,now);}
  const m=s.messageQueue[s.messageIndex];return {target:'provider',state:s,slug:'OUTLOOK_LIST_MAIL_FOLDER_MESSAGE_ATTACHMENTS',args:{user_id:'me',mail_folder_id:s.scanFolders[s.mailIndex],message_id:m.id,top:100,skip:s.attachmentSkip||0,response_detail:'minimal'}};
 }
 if(s.phase==='jobs'){
  if(s.jobIndex>=s.jobs.length){s.messageIndex++;s.jobs=[];s.jobIndex=0;s.phase='messages';return nextOutlookOperation(s,c,now);}
  const j=s.jobs[s.jobIndex];if(j.kind!=='attachment'){s.jobIndex++;return nextOutlookOperation(s,c,now);}
  const current=s.messageQueue[s.messageIndex],e=j.event,receipt={receipt_id:j.ack.receipt_id,account_id:'outlook:'+c.mailbox,partition_key:e.partition_key,message_id:e.message_id,attachment_id:e.attachment_id,artifact_kind:'attachment'};
  let job;try{job=outlookAttachmentJob({accountId:receipt.account_id,folderId:e.partition_key,message:current,metadata:j.metadata,sweepId:s.sweepId,event:e,ack:j.ack,receipt});}catch{s.jobIndex++;return nextOutlookOperation(s,c,now);}
  return {target:'child',state:s,payload:{job,receipt,event:e,ack:j.ack,sweep_id:s.sweepId}};
 }
 if(s.phase==='lookup')return {target:'backend',state:s,action:'intake_lookup_source',payload:{collector_id:c.collectorId,identities:[{account_id:'outlook:'+c.mailbox,partition_key:s.lookupEvent.partition_key,message_id:s.lookupEvent.message_id,attachment_id:s.lookupEvent.attachment_id}]}};
 if(s.phase==='retry_resolve')return {target:'backend',state:s,action:'intake_resolve_receipt_saved',payload:s.retryResolution};
 if(s.phase==='enumeration')return eventFor(s,{kind:'enumeration_complete',expected_message_count:s.messages,page_count:s.pages});
 if(s.phase==='finish')return {target:'backend',state:s,action:'intake_finish',payload:{sweep_id:s.sweepId,run_token:s.runToken}};
 throw Error('OUTLOOK_COLLECTOR_PHASE_INVALID');
}
export function applyOutlookResponse(context,response,c,now){const s=copy(context.state);if(context.target==='provider'){
 const data=responseBody(response),next=data.next_page_token||null;if(next!==null&&!str(next))throw Error('OUTLOOK_PROVIDER_CURSOR_INVALID');
 if(s.phase==='folder_roots'||s.phase==='folder_children'){
  if(!Array.isArray(data.value)||data.value.length>100)throw Error('OUTLOOK_FOLDERS_INVALID');
  for(const row of data.value){if(!obj(row)||!str(row.id)||!Number.isSafeInteger(row.childFolderCount)||row.childFolderCount<0||s.folders.some(f=>f.id===row.id))throw Error('OUTLOOK_FOLDER_DUPLICATE_OR_INVALID');
   if(s.phase==='folder_children'&&row.parentFolderId!==s.folderQueue[s.folderIndex])throw Error('OUTLOOK_CHILD_FOLDER_IDENTITY_INVALID');s.folders.push(row);if(s.phase==='folder_roots')s.rootIds.push(row.id);if(row.childFolderCount>0)s.folderQueue.push(row.id);}
  if(next){if(s.folderTokens.includes(next))throw Error('OUTLOOK_FOLDER_CURSOR_CYCLE');s.folderTokens.push(next);s.folderPage=next;return s;}
  s.folderPage=null;s.folderTokens=[];if(s.phase==='folder_roots'){s.phase='folder_excludes';s.excludeIndex=0;}else s.folderIndex++;return s;
 }
 if(s.phase==='folder_excludes'){if(!str(data.id)||!s.folders.some(x=>x.id===data.id))throw Error('OUTLOOK_EXCLUDED_FOLDER_UNPROVEN');s.excludedRoots.push(data.id);s.excludeIndex++;if(s.excludeIndex===3){s.folderQueue=s.folderQueue.filter(id=>!s.excludedRoots.includes(id));s.phase='folder_children';}return s;}
 if(s.phase==='mail_page'){const folder=s.scanFolders[s.mailIndex],page=outlookPage({folderId:folder,body:data,from:s.receivedFrom,through:s.receivedThrough,pageKey:String(s.mailPage),requestCursor:s.mailCursor,mailbox:c.mailbox});
  if(page.next_cursor&&s.mailTokens.includes(page.next_cursor)||page.messages.some(m=>s.mailSeen.includes(m.id)))throw Error('OUTLOOK_MESSAGE_PAGINATION_CYCLE');
  if(page.next_cursor)s.mailTokens.push(page.next_cursor);s.mailSeen.push(...page.messages.map(m=>m.id));
  s.messageQueue=page.messages;s.messageIndex=0;s.nextMailCursor=page.next_cursor;s.pages++;s.messages+=page.messages.length;return enqueue(s,[page.event],'messages');}
 if(s.phase==='messages'){
  const message=s.messageQueue[s.messageIndex],folder=s.scanFolders[s.mailIndex];
  // Preserve each page until the provider proves a terminal response. The API
  // does not accept skiptoken; unsupported continuation is an explicit failure.
  s.attachmentPages??=[];s.attachmentPages.push({skip:s.attachmentSkip||0,body:data});
  const nextLink=data['@odata.nextLink'];if(nextLink){let parsed;try{parsed=new URL(nextLink);}catch{throw Error('OUTLOOK_ATTACHMENTS_NEXT_INVALID');}const skip=parsed.searchParams.get('$skip');if(parsed.origin!=='https://graph.microsoft.com'||!/^\d{1,8}$/.test(skip||'')||Number(skip)<=(s.attachmentSkip||0))throw Error('OUTLOOK_ATTACHMENTS_PAGINATION_UNSUPPORTED');s.attachmentSkip=Number(skip);return s;}
  const result=outlookOrigins({folderId:folder,message,attachmentPages:s.attachmentPages});const metadata=s.attachmentPages.flatMap(p=>p.body.value);delete s.attachmentPages;delete s.attachmentSkip;
  s.jobs=result.outcomes.map(e=>({event:e,kind:e.code==='outlook_attachment_unprocessed'?'attachment':'review',metadata:metadata.find(a=>'outlook-attachment:'+a?.id===e.attachment_id)}));s.jobIndex=0;s.detailsRestored=true;
  const events=[result.message_event,...(result.origins_event?[result.origins_event]:[]),...result.details,...result.outcomes];if(result.inventoryIncomplete){s.issues.push({folder_id:folder,code:'outlook_attachment_identity_unproven'});events.push({kind:'failure',partition_key:folder,message_id:message.id,stage:'enumeration',code:'outlook_attachment_identity_unproven'});}
  if(!result.origins_event){s.messageIndex++;return enqueue(s,events,'messages');}
  return enqueue(s,events,'jobs');
 }
 throw Error('OUTLOOK_PROVIDER_PHASE_INVALID');
 }
 if(context.target==='backend'){
  if(context.action==='intake_begin'){if(!uuid(response.sweep_id)||!uuid(response.run_token))throw Error('OUTLOOK_BEGIN_ACK_INVALID');s.sweepId=response.sweep_id;s.runToken=response.run_token;s.phase='retry_jobs';}
  else if(context.action==='intake_resume'){if(response.sweep_id!==s.sweepId||!uuid(response.run_token)||response.run_token===s.resumeRequest?.runToken||response.resumed!==true||response.collector_id!==c.collectorId||response.scope_key!==digest(outlookManifest(c))||response.request_id!==s.requestId||Date.parse(response.received_from)!==Date.parse(s.receivedFrom)||Date.parse(response.received_through)!==Date.parse(s.receivedThrough)||!Number.isFinite(Date.parse(response.expires_at))||Date.parse(response.expires_at)<=now)throw Error('OUTLOOK_RESUME_ACK_INVALID');s.runToken=response.run_token;delete s.resumeRequest;}
  else if(context.action==='intake_event'){
   if(response.recorded!==true||response.sweep_id!==s.sweepId)throw Error('OUTLOOK_EVENT_ACK_INVALID');
   if(s.phase==='enumeration'){s.phase='finish';return s;}
   const e=s.pendingEvents.shift();if(e.kind==='origin_outcome'){delete s.outcomeChecked;delete s.outcomeLookup;}if(e.kind==='origin_outcome'&&e.disposition==='pending'){const j=s.jobs.find(x=>x.event.attachment_id===e.attachment_id);if(!j||!uuid(response.receipt_id))throw Error('OUTLOOK_RECEIPT_ACK_INVALID');j.ack=response;}
  }else if(context.action==='intake_lookup_source'){
   if(s.phase==='events'&&s.outcomeLookup){const e=s.outcomeLookup,item=response?.items?.[0];
    if(response?.contract!=='exam_intake_source_lookup_v1'||!item||!['saved','pending','not_found'].includes(item.status)||item.message_id!==e.message_id||item.attachment_id!==e.attachment_id)throw Error('OUTLOOK_LOOKUP_ACK_INVALID');
    if(item.status==='saved'&&item.match_kind==='exact_origin'&&item.canonical_file_preserved===true&&uuid(item.source_id)&&uuid(item.document_id)&&item.source_document_id===item.document_id&&/^[a-f0-9]{64}$/.test(item.sha256||'')&&Number.isSafeInteger(item.size_bytes)&&item.size_bytes>0){
     s.pendingEvents[0]={kind:'origin_outcome',partition_key:e.partition_key,message_id:e.message_id,attachment_id:e.attachment_id,disposition:'saved',source_id:item.source_id,document_id:item.document_id};const j=s.jobs.find(x=>x.event.attachment_id===e.attachment_id);if(j)j.kind='saved';}
    else if(item.status==='saved')throw Error('OUTLOOK_SAVED_PROOF_INVALID');
    else if(item.status==='pending'&&item.match_kind!=='exact_origin'){const j=s.jobs.find(x=>x.event.attachment_id===e.attachment_id);if(j)j.kind='review';}
    s.outcomeChecked=e.attachment_id;delete s.outcomeLookup;return s;}
   const item=response?.items?.[0];if(response?.contract!=='exam_intake_source_lookup_v1'||!item||item.message_id!==s.lookupEvent.message_id||item.attachment_id!==s.lookupEvent.attachment_id)throw Error('OUTLOOK_LOOKUP_ACK_INVALID');
   if(item.status==='saved'&&item.match_kind==='exact_origin'&&item.canonical_file_preserved===true&&uuid(item.source_id)&&uuid(item.document_id)&&item.source_document_id===item.document_id&&/^[a-f0-9]{64}$/.test(item.sha256||'')&&Number.isSafeInteger(item.size_bytes)&&item.size_bytes>0){
    delete s.childReason;delete s.noRetry;
    if(s.retrying){s.retryResolution={receipt_id:s.retryQueue[0].ack.receipt_id,source_id:item.source_id,document_id:item.document_id};s.phase='retry_resolve';return s;}
    return enqueue(s,[{...s.lookupEvent,disposition:'saved',source_id:item.source_id,document_id:item.document_id}],'advance_job');
   }
   const reason=s.childReason||'outlook_child_unconfirmed',identity=s.lookupEvent;
   if(s.retrying){if(s.noRetry)s.retryQueue.shift();else s.retryQueue.push(s.retryQueue.shift());s.retryRemaining--;s.retrying=false;s.phase='retry_jobs';}
   else {const j=s.jobs[s.jobIndex];if(!s.noRetry&&j&&j.kind==='attachment'&&!s.retryQueue.some(x=>x.ack.receipt_id===j.ack.receipt_id))s.retryQueue.push({...j,message:s.messageQueue[s.messageIndex],sweepId:s.sweepId});s.jobIndex++;s.phase='jobs';}delete s.noRetry;delete s.childReason;
   return enqueue(s,[{kind:'attachment_retry_failed',partition_key:identity.partition_key,message_id:identity.message_id,attachment_id:identity.attachment_id,code:reason}],s.phase);
  }else if(context.action==='intake_resolve_receipt_saved'){
   const expected=s.retryResolution;if(response?.contract!=='exam_intake_receipt_resolution_v1'||response.receipt_id!==expected.receipt_id||response.source_id!==expected.source_id||response.document_id!==expected.document_id||response.disposition!=='saved')throw Error('OUTLOOK_RETRY_RESOLUTION_UNPROVEN');
   s.retryQueue.shift();s.retryRemaining--;s.retrying=false;delete s.retryResolution;s.phase='retry_jobs';
  }else if(context.action==='intake_finish'){if(typeof response.coverageComplete!=='boolean'||typeof response.scanFinished!=='boolean')throw Error('OUTLOOK_FINISH_ACK_INVALID');s.finishResult=response;s.phase='done';
   if(!s.progressThrough||Date.parse(s.receivedThrough)>Date.parse(s.progressThrough))s.progressThrough=s.receivedThrough;
   if(response.coverageComplete===true){s.coverageProof={sweepId:s.sweepId,receivedThrough:s.receivedThrough};if(s.replay&&s.pendingBackfillFrom){s.pendingBackfillFrom=Date.parse(s.receivedThrough)>=Date.parse(s.progressThrough)?null:s.receivedThrough;}}
   else if(!s.pendingBackfillFrom||Date.parse(s.receivedFrom)<Date.parse(s.pendingBackfillFrom))s.pendingBackfillFrom=s.receivedFrom;
  }
  else throw Error('OUTLOOK_BACKEND_PHASE_INVALID');
  if(s.phase==='advance_job'){s.jobIndex++;s.phase='jobs';}return s;
 }
 if(context.target==='child'){s.noRetry=response?.reason==='outlook_non_pdf_review';s.childReason=typeof response?.reason==='string'&&/^outlook_[a-z0-9_]{1,88}$/.test(response.reason)?response.reason:'outlook_child_unconfirmed';s.retrying=s.phase==='retry_jobs';s.lookupEvent=s.retrying?s.retryQueue[0].event:s.jobs[s.jobIndex].event;s.phase='lookup';return s;}
 throw Error('OUTLOOK_RESPONSE_TARGET_INVALID');
}
export function applyOutlookFailure(context,c){const s=copy(context.state);if(context.target==='backend'){s.halt=true;return s;}
 if(context.target==='child'){s.childReason='outlook_child_unconfirmed';s.retrying=s.phase==='retry_jobs';s.lookupEvent=s.retrying?s.retryQueue[0].event:s.jobs[s.jobIndex].event;s.phase='lookup';return s;}
 if(context.target==='provider'&&s.phase==='messages'){
  const m=s.messageQueue[s.messageIndex],folder=s.scanFolders[s.mailIndex],known=(s.attachmentPages||[]).flatMap(p=>p.body.value);delete s.attachmentPages;delete s.attachmentSkip;
  s.issues.push({folder_id:folder,code:'outlook_attachment_inventory_failed'});
  const failure={kind:'failure',partition_key:folder,message_id:m.id,stage:'enumeration',code:'outlook_attachment_inventory_failed'};
  if(!known.length){s.messageIndex++;return enqueue(s,[{kind:'message_discovered',partition_key:folder,message_id:m.id,received_at:m.received_at},failure],'messages');}
  const pages=[];for(let offset=0;offset<known.length;offset+=99){const next=offset+99<known.length?`https://graph.microsoft.com/v1.0/me/messages/fixture/attachments?$skip=${offset+99}`:null;pages.push({skip:offset,body:{value:known.slice(offset,offset+99),...(next?{'@odata.nextLink':next}:{})}});}
  let result;try{result=outlookOrigins({folderId:folder,message:m,attachmentPages:pages,allowIncomplete:true});}catch{s.messageIndex++;return enqueue(s,[{kind:'message_discovered',partition_key:folder,message_id:m.id,received_at:m.received_at},failure],'messages');}
  if(!result.origins_event){s.messageIndex++;return enqueue(s,[result.message_event,failure],'messages');}
  s.jobs=result.outcomes.map(e=>({event:e,kind:e.code==='outlook_attachment_unprocessed'?'attachment':'review',metadata:known.find(a=>'outlook-attachment:'+a?.id===e.attachment_id)}));s.jobIndex=0;s.detailsRestored=true;
  return enqueue(s,[result.message_event,result.origins_event,...result.details,...result.outcomes,failure],'jobs');
 }
 if(context.target==='provider'&&s.phase==='folder_children'){s.issues.push({folder_id:s.folderQueue[s.folderIndex],code:'outlook_folder_listing_failed'});s.folderIndex++;s.folderPage=null;s.folderTokens=[];return enqueue(s,[{kind:'failure',partition_key:s.folderQueue[s.folderIndex-1],stage:'enumeration',code:'outlook_folder_listing_failed'}],'folder_children');}
 if(context.target==='provider'&&s.phase==='mail_page'){const folder=s.scanFolders[s.mailIndex];s.issues.push({folder_id:folder,code:'outlook_message_listing_failed'});s.mailIndex++;s.mailCursor=null;s.mailPage=0;s.mailTokens=[];s.mailSeen=[];return enqueue(s,[{kind:'failure',partition_key:folder,stage:'enumeration',code:'outlook_message_listing_failed'}],'mail_page');}
 if(context.target==='provider'&&s.sweepId){s.retryPhase=s.phase;return enqueue(s,[{kind:'failure',partition_key:'folders',stage:'enumeration',code:'outlook_folder_discovery_failed'}],'halt_before_retry');}
 s.halt=true;return s;}
