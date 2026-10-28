import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {validateHopelabNoticeV2Policy,applyHopelabNoticeV2Policy,verifyHopelabNoticeV2Reservation} from './hopelab-notice-v2-runtime.mjs';

const OWNERSHIP_ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const clone=value=>JSON.parse(JSON.stringify(value));
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const oldParseTail="const notice=$('Aviso Hopelab autorizado').item.json.hopelabNotice;const origins=parseHopelabNotice($json,notice,$('Janela de recebimento').first().json);return origins.map(json=>({json:{...json,resetAttachments:true}}));";
const oldReservationTail="return [{json:decideReservation($('Um anexo por vez').item.json,$json)}];";

function configurationLiteral(source) {
  const markers=[...source.matchAll(/\bconst cfg\s*=\s*(?=\{)/g)];
  if(markers.length!==1)throw new Error('hopelab_candidate_configuration_ambiguous');
  const start=markers[0].index+markers[0][0].length;
  let depth=0,quoted=false,escaped=false;
  for(let index=start;index<source.length;index++){
    const character=source[index];
    if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}
    if(character==='"')quoted=true;else if(character==='{')depth++;else if(character==='}'&&--depth===0)return JSON.parse(source.slice(start,index+1));
  }
  throw new Error('hopelab_candidate_configuration_invalid');
}

export function buildHopelabNoticeV2Candidate(baseline, suppliedPolicy, {now=new Date()}={}) {
  const original=Array.isArray(baseline)&&baseline.length===1?baseline[0]:baseline;
  if(!original || typeof original.id!=='string' || !Array.isArray(original.nodes) || !original.settings || !original.connections
    || new Set(original.nodes.map(node=>node.name)).size!==original.nodes.length)throw new Error('hopelab_candidate_existing_export_required');
  const settings=original.nodes.find(node=>node.name==='Configuração');
  const cfg=configurationLiteral(settings?.parameters?.jsCode || '');
  if(!cfg.mailbox || !cfg.serviceUrl || cfg.manualMessageId || cfg.manualConversationId)throw new Error('hopelab_candidate_configuration_not_operational');
  const policy=validateHopelabNoticeV2Policy({...suppliedPolicy,accountId:'gmail:'+cfg.mailbox});
  const instant=Number(now),cutover=Date.parse(policy.cutover);
  if(!Number.isFinite(instant) || cutover<instant-15*60*1000 || cutover>instant+86400000)throw new Error('hopelab_candidate_cutover_must_be_prospective');
  const prepared=clone(original),changes=[];
  const node=name=>prepared.nodes.find(value=>value.name===name);
  const patch=(name,tail,replacement)=>{
    const target=node(name);
    if(target?.type!=='n8n-nodes-base.code' || typeof target.parameters.jsCode!=='string'
      || target.parameters.jsCode.split(tail).length!==2 || !target.parameters.jsCode.trimEnd().endsWith(tail))throw new Error('hopelab_candidate_source_drift:'+name);
    const before=target.parameters.jsCode;
    target.parameters.jsCode=before.slice(0,before.lastIndexOf(tail))+replacement+'\n';
    new vm.Script('(async function(){'+target.parameters.jsCode+'})');
    changes.push({name,before_sha256:digest(before),after_sha256:digest(target.parameters.jsCode)});
  };
  const parseReplacement=validateHopelabNoticeV2Policy.toString()+'\n'+applyHopelabNoticeV2Policy.toString()
    +"\nconst notice=$('Aviso Hopelab autorizado').item.json.hopelabNotice;const policy="+JSON.stringify(policy)+";const origins=parseHopelabNotice($json,notice,$('Janela de recebimento').first().json).map(origin=>applyHopelabNoticeV2Policy(origin,policy));return origins.map(json=>({json:{...json,resetAttachments:true}}));";
  patch('Extrair link Hopelab autorizado',oldParseTail,parseReplacement);
  patch('Decidir recebimento',oldReservationTail,verifyHopelabNoticeV2Reservation.toString()+"\nconst origin=$('Um anexo por vez').item.json;verifyHopelabNoticeV2Reservation(origin,$json);return [{json:decideReservation(origin,$json)}];");
  for(const name of ['Decidir recebimento','Extrair link Hopelab autorizado'])if(node(name).onError!=='continueErrorOutput')throw new Error('hopelab_candidate_error_path_missing:'+name);
  if(!node('Reservar origem')?.credentials?.httpHeaderAuth?.id || /^SELECT_/.test(node('Reservar origem').credentials.httpHeaderAuth.id))throw new Error('hopelab_candidate_existing_worker_reference_missing');
  if(prepared.nodes.length!==original.nodes.length || JSON.stringify(prepared.connections)!==JSON.stringify(original.connections)
    || JSON.stringify(prepared.settings)!==JSON.stringify(original.settings))throw new Error('hopelab_candidate_unexpected_topology_change');
  return {workflow:prepared,manifest:{publication:'not_applied',backendContractRequired:policy.backendContract,
    cutoff:policy.cutover,replayNoticeIds:policy.replayNoticeIds,account_sha256:digest(policy.accountId),baseline_sha256:digest(original),
    prepared_sha256:digest(prepared),changes,unchangedNodeCount:original.nodes.length-changes.length,
    preserved:['workflow_metadata','configuration_literal','all_credential_references','node_ids','node_positions','connections','settings','delivery_state'],
    safety:'V2 notices stop before download unless the authenticated backend attests its review guard contract'}};
}

async function externalLocation(target) {
  let ancestor=path.resolve(target);const suffix=[];
  while(true){try{const actual=path.join(await fs.realpath(ancestor),...suffix.reverse());const relative=path.relative(await fs.realpath(OWNERSHIP_ROOT),actual);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('hopelab_candidate_private_files_only');return actual;
  }catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;suffix.push(path.basename(ancestor));ancestor=parent;}}
}

export async function writeHopelabNoticeV2Candidate({baselineFile,policyFile,out,now}) {
  await externalLocation(baselineFile);await externalLocation(policyFile);await externalLocation(out);
  const baselineRaw=await fs.readFile(baselineFile,'utf8'),policyRaw=await fs.readFile(policyFile,'utf8');
  const result=buildHopelabNoticeV2Candidate(JSON.parse(baselineRaw),JSON.parse(policyRaw),now?{now:new Date(now)}:{});
  await fs.mkdir(out,{recursive:true,mode:0o700});
  const workflowFile=path.join(out,'gmail-hopelab-notice-v2.workflow.json'),manifestFile=path.join(out,'manifest.json');
  await fs.writeFile(workflowFile,JSON.stringify(result.workflow,null,2)+'\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(manifestFile,JSON.stringify({...result.manifest,baseline_export_sha256:digest(baselineRaw)},null,2)+'\n',{mode:0o600,flag:'wx'});
  return {workflowFile,manifestFile,publication:'not_applied',changedNodes:result.manifest.changes.length,prepared_sha256:result.manifest.prepared_sha256};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const flags=['--baseline','--policy','--out'],args=process.argv.slice(2);
  if(args.length!==6||new Set(args.filter((_,index)=>index%2===0)).size!==3||args.some((value,index)=>index%2===0&&!flags.includes(value)))throw new Error('Use --baseline <current-export> --policy <private-policy> --out <new-private-directory>');
  const values=Object.fromEntries(args.flatMap((value,index)=>index%2===0?[[value,args[index+1]]]:[]));
  console.log(JSON.stringify(await writeHopelabNoticeV2Candidate({baselineFile:values['--baseline'],policyFile:values['--policy'],out:values['--out']})));
}
