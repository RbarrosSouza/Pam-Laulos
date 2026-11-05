import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const BASE_IMAGE='ghcr.io/fazer-ai/chatwoot@sha256:924c852c0d5a231a4c1b63b0d22a55c0fb5ab899d73eb59986d7ceb5a05ff048';
export const CONTROLLER_SHA='23992625576e7d53ae7d61659c3aaf3c76b114c5476a8d41c6080edd984fbee8';
export async function buildProviderGuard({sourceController,out}){
 if(!sourceController||!out)throw Error('Private source controller and output required');
 const original=await fs.readFile(sourceController,'utf8');
 if(sha(original)!==CONTROLLER_SHA)throw Error('PAMVET_CHECK_CONTROLLER_BASE_MISMATCH');
 const first='class Api::V1::Accounts::Conversations::Messages::ReactionsController < Api::V1::Accounts::Conversations::BaseController\n';
 if(!original.startsWith(first)||original.split(first).length!==2)throw Error('PAMVET_CHECK_CONTROLLER_SHAPE_MISMATCH');
 const module=await fs.readFile(path.join(here,'pamvet_check_guard.rb'),'utf8');
 const controller=module+'\n'+original.replace(first,first+'  include PamvetCheckGuard\n');
 let resolved=path.resolve(out),ancestor=resolved;const suffix=[];
 while(true){try{resolved=path.join(await fs.realpath(ancestor),...suffix.reverse());break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;suffix.push(path.basename(ancestor));ancestor=parent;}}
 const repo=await fs.realpath(path.resolve(here,'../../..'));
 const rel=path.relative(repo,resolved);if(!rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel))throw Error('Output must stay outside repository');
 await fs.mkdir(resolved,{recursive:true,mode:0o700});
 const outputs={'reactions_controller.rb':controller,'patch-routes.rb':await fs.readFile(path.join(here,'patch-routes.rb'),'utf8'),'Dockerfile':await fs.readFile(path.join(here,'Dockerfile'),'utf8')};
 for(const[name,text]of Object.entries(outputs)){await fs.writeFile(path.join(resolved,name),text,{mode:0o600});await fs.chmod(path.join(resolved,name),0o600);}
 const manifest={contract:'pamvet_check_v1',baseImage:BASE_IMAGE,sourceControllerSha256:CONTROLLER_SHA,
  artifacts:Object.entries(outputs).map(([name,text])=>({name,sha256:sha(text)})),statePath:'/api/v1/accounts/:account_id/conversations/:conversation_id/messages/:message_id/reactions/state',
  ensurePath:'/api/v1/accounts/:account_id/conversations/:conversation_id/messages/:message_id/reactions/ensure',publication:'not_applied'};
 await fs.writeFile(path.join(resolved,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
 if(!args.includes('--source-controller')||!args.includes('--out'))throw Error('Use --source-controller PRIVATE_FILE --out PRIVATE_DIR');
 console.log(JSON.stringify(await buildProviderGuard({sourceController:get('--source-controller'),out:get('--out')}),null,2));
}
