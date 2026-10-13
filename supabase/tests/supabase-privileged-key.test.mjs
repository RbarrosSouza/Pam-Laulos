// Actual helper source executes in a VM with synthetic maps. No environment,
// credential store, provider, DB, request authentication or network is accessed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=await readFile(new URL('../functions/exam-document-service/supabase-privileged-key.ts',import.meta.url),'utf8');
const exports={};
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},reportDiagnostics:true});
assert.equal((compiled.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);
vm.runInNewContext(compiled.outputText,{exports},{timeout:1000});
const {selectExamSupabasePrivilegedKey:select,ExamSupabaseKeySelectionError}=exports;
const opt='EXAM_SUPABASE_SECRET_KEY_NAME',modern='SUPABASE_SECRET_KEYS',legacy='SUPABASE_SERVICE_ROLE_KEY';
const selectedMarker='sb_secret_synthetic_selected_marker',otherMarker='sb_secret_synthetic_other_marker';
const legacyMarker='synthetic_legacy_service_marker';
function fixture(extra={}) {
  const values=new Map(Object.entries({[legacy]:legacyMarker,...extra})),reads=[];
  return {values,reads,get(name){reads.push(name);return values.get(name)}};
}
function rejected(f,code,forbidden=[]) {
  assert.throws(()=>select(f.get),e=>{
    assert(e instanceof ExamSupabaseKeySelectionError);
    assert.equal(e.code,code);assert.equal(e.message,code);assert.equal(e.status,503);
    assert.equal(Object.hasOwn(e,'cause'),false);
    const publicError=JSON.stringify({...e,name:e.name,message:e.message,stack:e.stack});
    for(const marker of [selectedMarker,otherMarker,legacyMarker,...forbidden]) assert.equal(publicError.includes(marker),false);
    return true;
  });
  if(f.values.get(opt)!==undefined) assert.equal(f.reads.includes(legacy),false,'explicit modern opt-in never reads legacy');
}

test('explicit opt-in selects the exact named modern key, not the first/default key, without reading legacy',()=>{
  const f=fixture({[opt]:'exames',[modern]:JSON.stringify({default:otherMarker,exames:selectedMarker})});
  assert.equal(select(f.get),selectedMarker);assert.deepEqual(f.reads,[opt,modern]);
});
test('absent opt-in preserves exact legacy value and ignores even malformed modern map',()=>{
  const f=fixture({[modern]:'{malformed JSON'});
  assert.equal(select(f.get),legacyMarker);assert.deepEqual(f.reads,[opt,legacy]);
});
test('explicit empty, whitespace, control and wrong-type opt-in fails without consulting legacy or map',()=>{
  for(const name of ['', ' ', ' exames', 'exames ', 'ex\names', '\0', 'x'.repeat(257), null, 42, {}, []]) {
    const f=fixture({[opt]:name,[modern]:JSON.stringify({exames:selectedMarker})});
    rejected(f,'EXAM_SUPABASE_SECRET_KEY_NAME_INVALID');assert.deepEqual(f.reads,[opt]);
  }
});
test('missing modern map and malformed JSON/root shape fail closed with controlled errors',()=>{
  for(const value of [undefined,null,42,'','{','{"exames":"sb_secret_sensitive_parse_marker"','null','[]','"text"','true','123']) {
    const f=fixture({[opt]:'exames',[modern]:value});
    rejected(f,'EXAM_SUPABASE_SECRET_KEYS_INVALID',['sb_secret_sensitive_parse_marker']);
    assert.deepEqual(f.reads,[opt,modern]);
  }
});
test('missing exact entry and differing name casing do not fall back to another modern key or legacy',()=>{
  for(const map of [{}, {default:selectedMarker}, {Exames:selectedMarker}, {exames2:selectedMarker}]) {
    const f=fixture({[opt]:'exames',[modern]:JSON.stringify(map)});
    rejected(f,'EXAM_SUPABASE_SECRET_KEY_NOT_FOUND');
  }
});
test('selected entry must be a nonempty modern sb_secret string with no whitespace/control or wrong prefix',()=>{
  for(const entry of [null,true,42,{},[],'','sb_secret_','sb_publishable_synthetic_marker',legacyMarker,
    'sb_secret_synthetic with_space',' sb_secret_synthetic','sb_secret_synthetic\n','SB_SECRET_synthetic']) {
    const f=fixture({[opt]:'exames',[modern]:JSON.stringify({exames:entry})});
    rejected(f,'EXAM_SUPABASE_SECRET_KEY_INVALID');
  }
});
test('selection uses own entries; inherited property names cannot bypass an absent named entry',()=>{
  for(const name of ['toString','constructor','__proto__']) {
    const f=fixture({[opt]:name,[modern]:'{}'});rejected(f,'EXAM_SUPABASE_SECRET_KEY_NOT_FOUND');
  }
  const explicit=fixture({[opt]:'__proto__',[modern]:'{"__proto__":"'+selectedMarker+'"}'});
  assert.equal(select(explicit.get),selectedMarker);assert.deepEqual(explicit.reads,[opt,modern]);
});
test('opaque names match exactly without normalization or insertion of a default key',()=>{
  const f=fixture({[opt]:'Exames clínica',[modern]:JSON.stringify({'Exames clínica':selectedMarker,'exames clínica':otherMarker})});
  assert.equal(select(f.get),selectedMarker);assert.deepEqual(f.reads,[opt,modern]);
});
test('only the chosen entry is consumed; unrelated entries never become fallback candidates',()=>{
  const f=fixture({[opt]:'exames',[modern]:JSON.stringify({unrelated:null,exames:selectedMarker})});
  assert.equal(select(f.get),selectedMarker);assert.deepEqual(f.reads,[opt,modern]);
});
test('missing or wrong-type legacy key errors only when opt-in is absent and never reads the modern map',()=>{
  for(const entry of [undefined,null,42,{},[],'']) {
    const f=fixture({[legacy]:entry,[modern]:JSON.stringify({default:selectedMarker})});
    rejected(f,'EXAM_SUPABASE_LEGACY_KEY_MISSING');assert.deepEqual(f.reads,[opt,legacy]);
  }
});
test('environment-reader failures are sanitized and never fall back or retain the original exception/cause',()=>{
  for(const failingAt of [opt,modern,legacy]) {
    const f=fixture(failingAt===legacy?{}:{[opt]:'exames',[modern]:JSON.stringify({exames:selectedMarker})});
    const get=f.get;
    f.get=name=>{const value=get(name);if(name===failingAt)throw new Error('secret_reader_failure_'+selectedMarker);return value};
    rejected(f,'EXAM_SUPABASE_ENV_READ_FAILED',['secret_reader_failure_']);
  }
});
test('invalid dependency produces a controlled error; helper has no ambient environment or I/O dependency',()=>{
  assert.throws(()=>select(null),e=>e.code==='EXAM_SUPABASE_ENV_READER_INVALID'&&e.status===503);
  assert.equal(/Deno\.env|process\.env|\bfetch\s*\(|^import\s/m.test(source),false);
});
