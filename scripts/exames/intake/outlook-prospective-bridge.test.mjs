import test from 'node:test';
import assert from 'node:assert/strict';
import {outlookFolderManifest,outlookPage,outlookOrigins,outlookAttachmentJob,outlookAttachmentBytes} from './outlook-prospective-bridge.mjs';
const at='2026-10-28T05:00:00.000Z',end='2026-10-28T06:00:00.000Z';
const message={id:'IMMUTABLE-A',received_at:'2026-10-28T05:30:00.000Z'};
const attachment=id=>({'@odata.type':'#microsoft.graph.fileAttachment',id,size:1876,name:'',contentType:'application/pdf'});
const origin=outlookOrigins({folderId:'INBOX',message,attachmentPages:[{skip:0,body:{value:[1,2,3,4].map(x=>attachment('A'+x))}}]});
const ack={recorded:true,sweep_id:'SWEEP',receipt_id:'RECEIPT'};
const receipt={receipt_id:'RECEIPT',account_id:'outlook:test@example.invalid',partition_key:'INBOX',message_id:message.id,attachment_id:'outlook-attachment:A2',artifact_kind:'attachment'};
const mk=()=>outlookAttachmentJob({accountId:receipt.account_id,folderId:'INBOX',message,metadata:attachment('A2'),sweepId:'SWEEP',event:origin.outcomes[1],ack,receipt});

test('folder hierarchy excludes sent descendants and detects incomplete trees',()=>{
 const folders=[{id:'root',childFolderCount:2},{id:'inbox',parentFolderId:'root',childFolderCount:0},{id:'sent',parentFolderId:'root',childFolderCount:1},{id:'sent-child',parentFolderId:'sent',childFolderCount:0}];
 assert.deepEqual(outlookFolderManifest(folders,{excludedRoots:['sent']}),['inbox','root']);
 assert.throws(()=>outlookFolderManifest(folders.filter(f=>f.id!=='inbox'),{excludedRoots:['sent']}),/INCOMPLETE/);
});
test('every page carries a durable discovery event with complete IDs, scoped window and cursor',()=>{
 const page=outlookPage({folderId:'INBOX',pageKey:'page-1',from:at,through:end,body:{value:[{id:'ID-one',receivedDateTime:message.received_at},{id:'ID-two',receivedDateTime:message.received_at}],next_page_token:'opaque-next'}});
 assert.deepEqual(page.event.message_ids,['ID-one','ID-two']);assert.equal(page.event.is_terminal,false);assert.equal(page.next_cursor,'opaque-next');
 assert.throws(()=>outlookPage({folderId:'INBOX',pageKey:'p',from:at,through:end,body:{value:[], '@odata.nextLink':'https://graph.microsoft.com/next'}}),/CONTINUATION_UNSUPPORTED/);
});
test('four attachments create four independent pending events even without filenames',()=>{
 assert.equal(origin.origins_event.origins.length,4);assert.equal(origin.outcomes.length,4);assert.equal(new Set(origin.outcomes.map(x=>x.attachment_id)).size,4);
});
test('one malformed item leaves the other PDFs available; images require review',()=>{
 const files=[attachment('A1'),{...attachment('A2'),size:'invalid'},attachment('A3'),{...attachment('A4'),contentType:'image/png'}];
 const result=outlookOrigins({folderId:'INBOX',message:{...message,directionProven:true},attachmentPages:[{skip:0,body:{value:files}}]});
 assert.equal(result.outcomes.length,4);assert.equal(result.outcomes[1].code,'outlook_attachment_metadata_invalid');assert.equal(result.outcomes[2].code,'outlook_attachment_unprocessed');assert.equal(result.outcomes[3].code,'outlook_attachment_format_review');
});
test('self-sent, drafts and unknown sender require review rather than claiming incoming',()=>{
 const value=['fixture@example.invalid','lab@example.invalid',null].map((address,i)=>({id:'id'+i,receivedDateTime:message.received_at,isDraft:false,from:address?{emailAddress:{address}}:null}));
 const page=outlookPage({folderId:'INBOX',pageKey:'1',from:at,through:end,mailbox:'fixture@example.invalid',body:{value}});
 assert.deepEqual(page.messages.map(m=>m.directionProven),[false,true,false]);
 const item=outlookOrigins({folderId:'INBOX',message:page.messages[0],attachmentPages:[{skip:0,body:{value:[attachment('a')]}}]});assert.equal(item.outcomes[0].code,'outlook_direction_review_required');
});
test('message without attachments stays pending for possible clinical links',()=>{
 const result=outlookOrigins({folderId:'INBOX',message,attachmentPages:[{skip:0,body:{value:[]}}]});
 assert.equal(result.origins_event.origins[0].artifact_kind,'notice');assert.equal(result.outcomes[0].disposition,'pending');assert.equal(result.outcomes[0].code,'outlook_message_content_unclassified');
});
test('attachment pagination fails closed when incomplete, bad or unsupported',()=>{
 const first={skip:0,body:{value:[attachment('one')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages/a/attachments?$skip=100'}};
 assert.throws(()=>outlookOrigins({folderId:'INBOX',message,attachmentPages:[first]}),/PAGINATION_REQUIRED/);
 const second={skip:100,body:{value:[attachment('two')]}};
 assert.equal(outlookOrigins({folderId:'INBOX',message,attachmentPages:[first,second]}).outcomes.length,2);
 assert.throws(()=>outlookOrigins({folderId:'INBOX',message,attachmentPages:[first,{skip:50,body:{value:[]}}]}),/PAGE_INVALID/);
 assert.throws(()=>outlookOrigins({folderId:'INBOX',message,attachmentPages:[{skip:0,body:{value:[attachment('one')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages/a/attachments?$skiptoken=token'}}]}),/PAGINATION_REQUIRED/);
});
test('only a proven exact pending receipt can make a source job',()=>{
 const job=mk();assert.equal(job.source.original_name,'original.pdf');assert.equal(job.source.message_id,message.id);
 assert.throws(()=>outlookAttachmentJob({accountId:receipt.account_id,folderId:'INBOX',message,metadata:attachment('A2'),sweepId:'SWEEP',event:origin.outcomes[1],ack,receipt:{...receipt,attachment_id:'outlook-attachment:A1'}}),/ACK_UNPROVEN/);
 assert.throws(()=>outlookAttachmentJob({accountId:receipt.account_id,folderId:'INBOX',message,metadata:attachment('A2'),sweepId:'SWEEP',event:origin.outcomes[1],ack:{...ack,recorded:false},receipt}),/ACK_UNPROVEN/);
});
test('hash and transport size reflect complete bytes; upstream discrepancy is retained without claiming an error',()=>{
 const bytes=Buffer.from('%PDF-1.4\nSynthetic content\n%%EOF\n');const response={...attachment('A2'),contentBytes:bytes.toString('base64')};
 const result=outlookAttachmentBytes({job:mk(),response});assert.equal(result.size_bytes,bytes.length);assert.equal(result.provider_size,1876);assert.equal(result.provider_size_differs,true);assert.equal(result.drive_readback_required,true);assert.equal(result.clinical_processing_required,true);assert.match(result.sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>outlookAttachmentBytes({job:mk(),response:{...response,id:'A1'}}),/DOWNLOAD_UNPROVEN/);
 assert.throws(()=>outlookAttachmentBytes({job:mk(),response:{...response,contentBytes:Buffer.from('%PDF-1.4 no EOF').toString('base64')}}),/PDF_UNPROVEN/);
 assert.throws(()=>outlookAttachmentBytes({job:mk(),response:{...response,contentBytes:'@@bad'}}),/BASE64_INVALID/);
 assert.throws(()=>outlookAttachmentBytes({job:mk(),response:{...response,size:123}}),/METADATA_CHANGED/);
});
