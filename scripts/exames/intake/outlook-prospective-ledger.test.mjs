import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {collectionFixtureDB} from '../../../supabase/tests/collection-db.fixture.mjs';
import {outlookPage,outlookOrigins,outlookAttachmentJob} from './outlook-prospective-bridge.mjs';

test('Outlook page and four exact attachments persist before downstream processing',async()=>{
 const {db,rpc,role}=await collectionFixtureDB();
 try {
 await db.exec('RESET ROLE');
 for(const f of ['20261027000023_exam_intake_receipts_incidents.sql','20261028000030_exam_intake_pending_reconciliation.sql'])await db.exec(await readFile(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await role('service_role');
 const from=new Date(Date.now()-3600000).toISOString(),through=new Date(Date.now()-1000).toISOString();const received=new Date(Date.now()-60000).toISOString();
 const account='outlook:test@example.invalid',collector='outlook-fixture',manifest={provider:'outlook',account_id:account,scope_kind:'mailbox',policy_version:'intake_v2',sender_policy:'all',initial_received_from:from};
 const scope=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 const sweep=await rpc('begin_exam_intake_sweep',[collector,scope,JSON.stringify(manifest),from,through,crypto.randomUUID(),'audit',900]);
 const event=async v=>rpc('record_exam_intake_event',[sweep.sweep_id,sweep.run_token,JSON.stringify(v)]);
 const page=outlookPage({folderId:'inbox',pageKey:'page-one',from,through,body:{value:[{id:'immutable-message',receivedDateTime:received}]}});await event(page.event);
 const metadata=[1,2,3,4].map(x=>({id:'part-'+x,'@odata.type':'#microsoft.graph.fileAttachment',name:'',size:1876}));
 const origins=outlookOrigins({folderId:'inbox',message:page.messages[0],attachmentPages:[{skip:0,body:{value:metadata}}]});
 await event(origins.message_event);await event(origins.origins_event);const acks=[];for(const e of origins.outcomes)acks.push(await event(e));
 const pending=await rpc('list_exam_intake_pending_sources',[collector,null,50]);assert.equal(pending.items.length,4);
 const selected=pending.items.find(x=>x.attachment_id==='outlook-attachment:part-2');
 const job=outlookAttachmentJob({accountId:account,folderId:'inbox',message:page.messages[0],metadata:metadata[1],sweepId:sweep.sweep_id,event:origins.outcomes[1],ack:acks[1],receipt:selected});
 assert.equal(job.receipt_id,selected.receipt_id);assert.equal(job.source.original_name,'original.pdf');
 await event({kind:'enumeration_complete',expected_message_count:1,page_count:1});const result=await rpc('finish_exam_intake_sweep',[sweep.sweep_id,sweep.run_token]);
 assert.equal(result.coverageComplete,true);assert.equal(result.allPreserved,false);assert.equal(result.counts.pending,4);assert.equal(result.checkpointAdvanced,false);
 } finally {await db.close();}
});
