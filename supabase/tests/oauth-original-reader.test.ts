// Offline tests only: injected HTTP responses, synthetic credentials/IDs/PDFs.
import {OAUTH_MAX_PDF_BYTES,ComposioOriginalError,oauthDriveReaderConfig,readOAuthDriveOriginal,type OAuthDriveReaderConfig} from '../functions/exam-document-service/composio-original-reader.ts';
function assert(value:unknown,message='assertion failed'):asserts value{if(!value)throw new Error(message)}
function equal(a:unknown,b:unknown){assert(JSON.stringify(a)===JSON.stringify(b),`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)}
const bytes=new TextEncoder().encode('%PDF-1.4\nOAuth synthetic fixture\n%%EOF');
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
const expected={fileId:'oauth-fixture-file',folderId:'oauth-fixture-folder',sha256:hash,sizeBytes:bytes.length};
const refresh={refreshToken:'synthetic-refresh',clientId:'synthetic-client',clientSecret:'synthetic-secret'};
const token={access_token:'synthetic-access',token_type:'Bearer',expires_in:3600};
const meta={id:expected.fileId,mimeType:'application/pdf',size:String(bytes.length),parents:[expected.folderId],trashed:false,appProperties:{sha256:hash}};
const base='https://www.googleapis.com/drive/v3/files/'+expected.fileId;
const tokenURL='https://oauth2.googleapis.com/token';
function fixture(){
 const calls:{url:string;init?:RequestInit}[]=[];
 const state={metadata:{...meta},token:{...token},bytesResponse:()=>new Response(bytes,{headers:{'Content-Length':String(bytes.length)}}),
   tokenResponse:()=>Response.json(state.token),metadataResponse:()=>Response.json(state.metadata)};
 const fetcher:typeof fetch=async(input,init)=>{const url=input instanceof Request?input.url:String(input);calls.push({url,init});
  if(url===tokenURL)return state.tokenResponse();if(url===base+'?alt=media&supportsAllDrives=true')return state.bytesResponse();
  if(url===base+'?fields=id,mimeType,size,sha256Checksum,parents,trashed,appProperties&supportsAllDrives=true')return state.metadataResponse();
  throw new Error('Unexpected offline URL '+url);
 };
 return {calls,state,fetcher,run:(config:OAuthDriveReaderConfig=refresh)=>readOAuthDriveOriginal(expected,config,{fetch:fetcher})};
}
async function refused(run:()=>Promise<unknown>,status:number){try{await run();throw new Error('Unexpected success')}catch(error){assert(error instanceof ComposioOriginalError);equal(error.status,status);assert(!/synthetic-(?:access|secret|refresh)|confidential|oauth2.googleapis.com|PRIVATE_VALUE/.test(error.message),'secret/transport details escaped')}}
Deno.test('OAuth server config reads only names and needs complete refresh tuple or one temporary access token',()=>{
 const names:string[]=[];const values=new Map([['GOOGLE_DRIVE_REFRESH_TOKEN',refresh.refreshToken],['GOOGLE_DRIVE_CLIENT_ID',refresh.clientId],['GOOGLE_DRIVE_CLIENT_SECRET',refresh.clientSecret]]);
 equal(oauthDriveReaderConfig(name=>{names.push(name);return values.get(name)}),refresh);equal(names,['GOOGLE_DRIVE_REFRESH_TOKEN','GOOGLE_DRIVE_CLIENT_ID','GOOGLE_DRIVE_CLIENT_SECRET']);
 equal(oauthDriveReaderConfig(name=>name==='GOOGLE_DRIVE_ACCESS_TOKEN'?'synthetic-access':undefined),{accessToken:'synthetic-access'});
 for(const get of [()=>undefined,(name:string)=>name==='GOOGLE_DRIVE_REFRESH_TOKEN'?'partial':undefined]){
   try{oauthDriveReaderConfig(get);throw new Error('Unexpected config accepted')}catch(error){assert(error instanceof ComposioOriginalError);equal(error.status,503)}
 }
});
Deno.test('refresh then metadata and native media return exact PDF with fixed endpoints and no redirect/cookies',async()=>{
 const f=fixture();equal([...new Uint8Array(await f.run())],[...bytes]);equal(f.calls.length,3);
 const first=f.calls[0];equal(first.url,tokenURL);equal(first.init?.method,'POST');equal(new Headers(first.init?.headers).get('Authorization'),null);
 const params=first.init?.body as URLSearchParams;equal(params.get('grant_type'),'refresh_token');equal(params.get('refresh_token'),refresh.refreshToken);
 for(const call of f.calls){equal(call.init?.redirect,'error');equal(call.init?.credentials,'omit');assert(call.init?.signal)}
 for(const call of f.calls.slice(1))equal(new Headers(call.init?.headers).get('Authorization'),'Bearer '+token.access_token);
 assert(f.calls.every(call=>call.init?.method!=='PATCH'));assert(!f.calls.some(call=>call.url.includes('/export')));
});
Deno.test('temporary access token path has no refresh and caller mutation cannot replace credentials after dispatch',async()=>{
 const f=fixture(),config={accessToken:'synthetic-access'};
 const actual:typeof fetch=async(input,init)=>{config.accessToken='mutated-secret';return f.fetcher(input,init)};
 equal([...new Uint8Array(await readOAuthDriveOriginal(expected,config,{fetch:actual}))],[...bytes]);equal(f.calls.length,2);
 assert(f.calls.every(call=>new Headers(call.init?.headers).get('Authorization')==='Bearer synthetic-access'));
});
Deno.test('failed refresh never falls back to a supplied access token or retries a request',async()=>{
 const f=fixture();f.state.tokenResponse=()=>new Response('confidential synthetic-secret',{status:401});
 await refused(()=>f.run({...refresh,accessToken:'fallback-token'}),503);equal(f.calls.length,1);equal(f.calls[0].url,tokenURL);
});
Deno.test('expected file/folder/hash/size are validated before any token or Drive request',async()=>{
 for(const change of [{fileId:'https://private.invalid'},{folderId:null},{sha256:'bad'},{sizeBytes:0},{sizeBytes:OAUTH_MAX_PDF_BYTES+1}]){
   const f=fixture();await refused(()=>readOAuthDriveOriginal({...expected,...change},refresh,{fetch:f.fetcher}),change.sizeBytes===OAUTH_MAX_PDF_BYTES+1?413:409);equal(f.calls.length,0);
 }
});
Deno.test('native metadata mismatch refuses media before reading any file bytes',async()=>{
 for(const changed of [{id:'other'},{parents:['wrong-folder']},{mimeType:'text/plain'},{trashed:true},{size:String(bytes.length+1)},{appProperties:{sha256:'f'.repeat(64)}},{sha256Checksum:'f'.repeat(64)}]){
   const f=fixture();Object.assign(f.state.metadata,changed);await refused(()=>f.run(),409);equal(f.calls.length,2);
 }
});
Deno.test('metadata status/redirect/JSON failure is controlled and cannot leak provider body or retry',async()=>{
 for(const status of [302,401,403,404,500]){const f=fixture();f.state.metadataResponse=()=>new Response('confidential PRIVATE_VALUE=synthetic-secret',{status});await refused(()=>f.run(),503);equal(f.calls.length,2)}
 const bad=fixture();bad.state.metadataResponse=()=>new Response('{bad',{headers:{'Content-Type':'application/json'}});await refused(()=>bad.run(),503);equal(bad.calls.length,2);
});
Deno.test('malformed refresh token body cannot become an Authorization header',async()=>{
 for(const changed of [{access_token:'bad\r\ntoken'},{token_type:'other'},{expires_in:0},{expires_in:Infinity},{expires_in:'3600'}]){
   const f=fixture();Object.assign(f.state.token,changed);await refused(()=>f.run(),503);equal(f.calls.length,1);
 }
});
Deno.test('token JSON declared/chunked oversize stops early and cancels the body',async()=>{
 const declared=fixture();declared.state.tokenResponse=()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'32769'}});await refused(()=>declared.run(),503);equal(declared.calls.length,1);
 const f=fixture();let canceled=false,pulls=0;
 f.state.tokenResponse=()=>new Response(new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(8192))},cancel(){canceled=true}}),{headers:{'Content-Type':'application/json'}});
 await refused(()=>f.run(),503);assert(canceled);assert(pulls<=6);equal(f.calls.length,1);
});
Deno.test('native media declared/short/corrupt PDF bodies refuse confirmation',async()=>{
 const declared=fixture();declared.state.bytesResponse=()=>new Response(bytes,{headers:{'Content-Length':'999'}});await refused(()=>declared.run(),409);
 const short=fixture();short.state.bytesResponse=()=>new Response(bytes.slice(0,-1));await refused(()=>short.run(),409);
 const bad=fixture();bad.state.bytesResponse=()=>new Response(new Uint8Array(bytes.length));await refused(()=>bad.run(),409);
 const modified=fixture();const corrupted=bytes.slice();corrupted[10]^=1;modified.state.bytesResponse=()=>new Response(corrupted);await refused(()=>modified.run(),409);
});
Deno.test('OAuth keeps the legacy 50 MiB stream cap even without Content-Length',async()=>{
 const f=fixture();let canceled=false,pulls=0;f.state.metadata.size=String(OAUTH_MAX_PDF_BYTES);
 f.state.bytesResponse=()=>new Response(new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024))},cancel(){canceled=true}}));
 await refused(()=>readOAuthDriveOriginal({...expected,sizeBytes:OAUTH_MAX_PDF_BYTES},refresh,{fetch:f.fetcher}),413);assert(canceled);assert(pulls<=53);
});
Deno.test('refresh/metadata stalled fetch and stalled media body are bounded by the same total deadline',async()=>{
 for(const phase of ['token','metadata','media']){
   const f=fixture();let canceled=false,aborted=false;
   const http:typeof fetch=async(input,init)=>{
     const url=String(input),match=phase==='token'?url===tokenURL:phase==='metadata'?url.includes('?fields='):url.includes('?alt=media');
     if(!match)return f.fetcher(input,init);init?.signal?.addEventListener('abort',()=>{aborted=true},{once:true});
     if(phase==='media')return new Response(new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{})},cancel(){canceled=true}}));
     return await new Promise<Response>(()=>{});
   };
   await refused(()=>readOAuthDriveOriginal(expected,refresh,{fetch:http,timeoutMs:30}),503);assert(aborted);if(phase==='media')assert(canceled);
 }
});
Deno.test('native transport exceptions and rotated/expired token responses never expose URL/body/secret',async()=>{
 const raw=new Error('PRIVATE_VALUE=synthetic-secret confidential https://oauth2.googleapis.com/token');
 await refused(()=>readOAuthDriveOriginal(expected,refresh,{fetch:async()=>{throw raw}}),503);
 const f=fixture();f.state.tokenResponse=()=>Response.json({error:'invalid_grant',error_description:'confidential synthetic-refresh'},{status:400});await refused(()=>f.run(),503);equal(f.calls.length,1);
});
Deno.test('stateless second read refreshes again, does not cache/persist a token and does not change caller config',async()=>{
 const f=fixture(),config={...refresh};await f.run(config);await f.run(config);equal(config,refresh);equal(f.calls.filter(c=>c.url===tokenURL).length,2);equal(f.calls.length,6);
});
