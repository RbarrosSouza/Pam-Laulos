import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const KINDS=['intake','processing','group','nexus'];
const templates=await Promise.all(KINDS.map((_,i)=>fs.readFile(path.join(ROOT,'n8n/exames/OPERACIONAL-0'+(i+1)+'.json'),'utf8').then(JSON.parse)));
const clone=value=>JSON.parse(JSON.stringify(value));
function configLiteral(workflow){
 const source=workflow.nodes.find(n=>n.name==='Configuração').parameters.jsCode;
 const start=source.indexOf('const cfg=')+'const cfg='.length;
 const end=source.indexOf(';\nif(',start);
 if(start<10||end<start)throw new Error('Operational template configuration is missing');
 return source.slice(start,end);
}
export const CONFIG=Object.freeze(JSON.parse(configLiteral(templates[0])));
export const CREDENTIALS=Object.freeze({
 gmail:{id:'SELECT_GMAIL_OAUTH',name:'Select Gmail OAuth'},
 drive:{id:'SELECT_DRIVE_OAUTH',name:'Select Drive OAuth'},
 worker:{id:'SELECT_WORKER_HEADER',name:'Select exam worker header'},
 chatwoot:{id:'SELECT_CHATWOOT_CREDENTIAL',name:'Select Chatwoot credential'},
 extractor:{id:'SELECT_OPENAI_CREDENTIAL',name:'Select OpenAI credential'},
});
const inRoot=target=>{const relative=path.relative(ROOT,path.resolve(target));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
function validatePrivateSettings(settings){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>!['config','credentials'].includes(k)))throw new Error('Use only {config,credentials}; never put secret values in this file');
 const configuration=settings.config??{};
 if(!configuration||typeof configuration!=='object'||Array.isArray(configuration)||Object.keys(configuration).some(k=>!Object.hasOwn(CONFIG,k)))throw new Error('Unknown operational configuration field');
 const credentials=settings.credentials??{};
 if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(k=>!Object.hasOwn(CREDENTIALS,k)))throw new Error('Unknown credential reference');
 for(const reference of Object.values(credentials))if(!reference||typeof reference!=='object'||Array.isArray(reference)||Object.keys(reference).some(k=>!['id','name'].includes(k))||typeof reference.id!=='string'||!reference.id||reference.id.length>200||typeof reference.name!=='string'||!reference.name||reference.name.length>200||/[\x00-\x1f\x7f]/.test(reference.id+reference.name))throw new Error('Credential references accept id/name only, never token/key/value');
 return {configuration,credentials};
}
export async function buildWorkflows(settings={}){
 const {configuration,credentials}=validatePrivateSettings(settings);
 const config={...clone(CONFIG),...configuration};
 const refs={...clone(CREDENTIALS),...clone(credentials)};
 if(typeof config.enabled!=='boolean'||typeof config.mailbox!=='string'||!config.mailbox.includes('@')||typeof config.dedicatedMailbox!=='boolean'||typeof config.includeSpamTrash!=='boolean')throw new Error('Invalid operational configuration types');
 const result={};
 for(let i=0;i<templates.length;i++){
  const workflow=clone(templates[i]);
  for(const node of workflow.nodes){
   if(node.name==='Configuração')node.parameters.jsCode=node.parameters.jsCode.replace(configLiteral(workflow),JSON.stringify(config,null,2));
   if(node.parameters.jsCode)node.parameters.jsCode=node.parameters.jsCode.replace('const EXPECTED_MAILBOX='+JSON.stringify(CONFIG.mailbox), 'const EXPECTED_MAILBOX='+JSON.stringify(config.mailbox));
   for(const type of Object.keys(node.credentials||{})){
    const ref=type==='oAuth2Api'?(node.name.startsWith('Gmail -')?refs.gmail:refs.drive):type==='httpHeaderAuth'?refs.worker:type==='chatwootApi'?refs.chatwoot:type==='openAiApi'?refs.extractor:null;
    if(!ref)throw new Error('Unsupported operational credential type');
    node.credentials[type]=clone(ref);
   }
  }
  result[KINDS[i]]=workflow;
 }
 return result;
}
export async function writeWorkflows(out=path.join(ROOT,'n8n/exames'),settings={}){
 if(Object.keys(settings).length&&inRoot(out))throw new Error('Bound workflows must be written outside the public repository');
 const workflows=await buildWorkflows(settings);await fs.mkdir(out,{recursive:true});
 const result=[];let i=0;
 for(const workflow of Object.values(workflows)){
  const target=path.join(out,'OPERACIONAL-0'+(++i)+'.json');const text=JSON.stringify(workflow,null,2)+'\n';
  await fs.writeFile(target,text,{mode:0o600});if(Object.keys(settings).length)await fs.chmod(target,0o600);
  result.push({path:target,nodes:workflow.nodes.length,sha256:crypto.createHash('sha256').update(text).digest('hex')});
 }
 return result;
}
function argument(name){const args=process.argv.slice(2),at=args.indexOf(name);return at>=0?args[at+1]:args.find(v=>v.startsWith(name+'='))?.slice(name.length+1);}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const configPath=argument('--config'),out=argument('--out');
 const invalid=process.argv.slice(2).filter((v,i,a)=>!v.startsWith('--config=')&&!v.startsWith('--out=')&&!['--config','--out'].includes(v)&&!['--config','--out'].includes(a[i-1]));
 if(invalid.length)throw new Error('Use --config <private-config.local> --out <private-directory>');
 if(configPath&&(!out||inRoot(configPath)))throw new Error('Use an external private config and an external --out directory');
 const settings=configPath?JSON.parse(await fs.readFile(path.resolve(configPath),'utf8')):{};
 console.log(JSON.stringify(await writeWorkflows(out?path.resolve(out):undefined,settings),null,2));
}
