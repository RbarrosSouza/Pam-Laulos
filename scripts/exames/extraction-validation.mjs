/** Pure, self-contained validator embedded in n8n. Never completes names from a registry. */
export function validateExamExtraction(context, response) {
  const fallback = reason => ({classification:'review', single_patient:false, fields:{}, evidence:[], review_reason:reason, extractor_version:'document-evidence-v2'});
  const allowed = ['pet_name','client_name','exam_type','exam_date','lab_name','species','report_number'];
  const normalized = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const comparable = value => normalized(value).toLocaleLowerCase('pt-BR');
  const meaningful = value => typeof value === 'string' && /[\p{L}\p{N}]/u.test(value) && value.length <= 300;
  if (!Array.isArray(context.pages) || !context.pages.every(page => typeof page === 'string') || context.pages.length !== context.totalPages || !context.pages.some(page => page.trim())) return fallback('Texto ou paginação inválidos; conferir documento');
  let data;
  try { data = JSON.parse(response?.choices?.[0]?.message?.content || ''); }
  catch { return fallback('Resposta do extrator sem JSON válido; conferir documento'); }
  if (!data || !['exam','review','not_exam'].includes(data.classification) || typeof data.single_patient !== 'boolean' || !data.fields || typeof data.fields !== 'object' || Array.isArray(data.fields) || !Array.isArray(data.evidence)) return fallback('Estrutura da resposta do extrator inválida; conferir documento');

  // Map equivalent whitespace/Unicode back to exact offsets in the original page.
  // This accepts a line-wrapped name, but never joins words or crosses pages.
  function indexed(text) {
    let value = ''; const starts = [], ends = [];
    const segments = new Intl.Segmenter('pt-BR', {granularity:'grapheme'}).segment(text);
    for (const part of segments) {
      const next = part.index + part.segment.length;
      for (const char of part.segment.normalize('NFKC')) {
        const replacement = /\s/u.test(char) ? ' ' : char;
        if (replacement === ' ' && value.endsWith(' ')) { ends[ends.length - 1] = next; continue; }
        value += replacement;
        for (let i = 0; i < replacement.length; i++) { starts.push(part.index); ends.push(next); }
      }
    }
    return {value, starts, ends};
  }
  const mappedPages = context.pages.map(indexed);
  function locateEvidence(ev) {
    if (!ev || !allowed.includes(ev.field) || typeof ev.excerpt !== 'string' || !ev.excerpt.trim() || !Number.isSafeInteger(ev.page) || ev.page < 1 || ev.page > context.totalPages) return [];
    const page = mappedPages[ev.page - 1], needle = normalized(ev.excerpt), matches = [];
    if (!needle) return matches;
    for (let at = page.value.indexOf(needle); at >= 0; at = page.value.indexOf(needle, at + 1)) {
      const start = page.starts[at], end = page.ends[at + needle.length - 1];
      matches.push({field:ev.field, page:ev.page, excerpt:context.pages[ev.page - 1].slice(start, end), start, end});
    }
    return matches;
  }
  function occurrences(excerpt, value) {
    const haystack = comparable(excerpt), needle = comparable(value), hits = [];
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      if (!/[\p{L}\p{N}]/u.test(haystack[at - 1] || '') && !/[\p{L}\p{N}]/u.test(haystack[at + needle.length] || '')) hits.push(at);
    }
    return hits;
  }
  function supportsDate(ev, value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) return false;
    const [year,month,day] = value.split('-');
    const variants = [value, ...['/','.', '-'].flatMap(separator => [...new Set([day,String(Number(day))])].flatMap(d => [...new Set([month,String(Number(month))])].map(m => d + separator + m + separator + year)))];
    const clinicalLabel = /(?:data\s+(?:(?:da|de|do)\s+)?(?:realiza[cç][aã]o(?:\s+(?:do|de)\s+exame)?|coleta|exame)|realiza[cç][aã]o(?:\s+(?:do|de)\s+exame)?|coleta|exame\s+realizado|realizad[oa]|coletad[oa])(?:\s+em)?\s*[:=-]?\s*$/iu;
    const page = context.pages[ev.page - 1], indexedExcerpt = indexed(ev.excerpt);
    for (const variant of variants) for (const at of occurrences(ev.excerpt, variant)) {
      // The label must immediately qualify this date, not some other date in the quote.
      const rawStart = ev.start + indexedExcerpt.starts[at];
      const prefix = page.slice(Math.max(0, rawStart - 160), rawStart);
      const label = prefix.split(/\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|[;.!?]/u).at(-1);
      if (/\b(?:laudo|emiss[aã]o|assinatura|receb(?:ido|imento)|n[aã]o)\b/iu.test(label)) continue;
      if (clinicalLabel.test(normalized(label))) return true;
    }
    return false;
  }

  const fields = {}, evidence = [], invalid = [];
  const candidates = data.evidence.flatMap(locateEvidence);
  for (const field of allowed) {
    if (!Object.hasOwn(data.fields, field)) continue;
    const value = data.fields[field];
    if (value === null) { fields[field] = null; continue; }
    const valid = meaningful(value) && candidates.filter(ev => ev.field === field).find(ev => field === 'exam_date' ? supportsDate(ev, value) : occurrences(ev.excerpt, value).length > 0);
    if (!valid) { fields[field] = null; invalid.push(field); continue; }
    fields[field] = value;
    evidence.push({field:valid.field,page:valid.page,excerpt:valid.excerpt});
  }
  const incomplete = data.classification === 'exam' && (!data.single_patient || !fields.pet_name || !fields.client_name);
  const reasons = typeof data.review_reason === 'string' && data.review_reason.trim() ? [data.review_reason.trim().slice(0,1500)] : [];
  if (incomplete) reasons.push('Identificação incompleta; conferir tutor e pet no Pam Laudos');
  if (invalid.length) reasons.push('Campos sem comprovação suficiente no PDF: ' + invalid.join(', ') + '; conferir no Pam Laudos');
  const invalidCore = invalid.some(field => ['pet_name','client_name','exam_type','exam_date'].includes(field));
  return {
    classification:data.classification === 'not_exam' ? 'not_exam' : incomplete || invalidCore ? 'review' : data.classification,
    single_patient:data.single_patient, fields, evidence,
    review_reason:reasons.join('; ') || null, extractor_version:'document-evidence-v2',
  };
}
