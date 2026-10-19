/** Pure, self-contained validator embedded in n8n. Never completes names from a registry. */
export function validateExamExtraction(context, response) {
  const fallback = reason => ({classification:'review', single_patient:false, fields:{}, evidence:[], review_reason:reason, extractor_version:'document-evidence-v5'});
  const allowed = ['pet_name','client_name','exam_type','exam_date','lab_name','species','report_number','requesting_vet_name','requesting_vet_crmv'];
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
  function printedDateISO(value) {
    const printed = normalized(value), parts = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/u.exec(printed);
    const iso = parts ? parts[4] + '-' + parts[3].padStart(2,'0') + '-' + parts[1].padStart(2,'0') : printed;
    return /^\d{4}-\d{2}-\d{2}$/u.test(iso) && Number.isFinite(Date.parse(iso + 'T00:00:00Z')) && new Date(iso + 'T00:00:00Z').toISOString().slice(0,10) === iso ? iso : null;
  }
  function identificationTable(excerpt) {
    // n8n joins PDF text with single spaces; some documents retain larger gaps.
    // Evidence was already mapped back to the exact original text above.
    const rows = excerpt.split(/\r\n?|\n/u).map(line => line.trim()).filter(Boolean);
    const cells = row => row.split(/[ \t]{2,}|\t+/u).map(normalized);
    const result = {};
    for (let row = 0; row + 1 < rows.length; row++) {
      const headers = cells(rows[row]), values = cells(rows[row + 1]);
      const header = normalized(rows[row]), next = normalized(rows[row + 1]);
      const columnar = headers.length === 3 && values.length === 3 && values.every(Boolean);
      if (/^cl[ií]nica\s+veterin[aá]ria\s+m[eé]dic[oa]\s+veterin[aá]ri[oa]\s+crmv$/iu.test(header)) {
        const registration = /^(.*?)\s+((?:[A-Z]{2}\s*[-/]?\s*\d{3,8}|\d{3,8}\s*[-/]?\s*[A-Z]{2})|\d{3,8})$/iu.exec(next);
        if (columnar) { result.vetName = values[1]; result.vetRegistration = values[2]; }
        else if (registration) { result.vetValues = registration[1]; result.vetRegistration = registration[2]; }
      }
      if (/^(?:paciente|pet|animal|nome\s+do\s+paciente)\s+idade\s+sexo$/iu.test(header)) {
        const patient = /^(.+?)\s+\d+(?:[.,]\d+)?\s*(?:a|m|d|anos?|meses?|dias?)\s+(?:f[eê]mea|macho|f|m)$/iu.exec(next);
        if (columnar && /\p{L}/u.test(values[0])) result.patient = values[0];
        else if (patient && /\p{L}/u.test(patient[1])) result.patient = patient[1];
      }
      if (/^(?:respons[aá]vel|tutor(?:a)?)\s+ra[cç]a\s+data\s+(?:(?:da|de)\s+)?coleta$/iu.test(header)) {
        const dates = next.match(/\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}/gu) || [];
        if (dates.length === 1 && next.endsWith(dates[0]) && /\p{L}/u.test(next.slice(0,-dates[0].length))) {
          result.guardian = columnar ? values[0] : next.slice(0,-dates[0].length).trim(); result.guardianColumnar = columnar; result.collectionDate = printedDateISO(dates[0]);
        }
      }
    }
    return result;
  }
  function supportsDate(ev, value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) return false;
    if (normalized(ev.excerpt).length <= 1500 && identificationTable(ev.excerpt).collectionDate === value) return true;
    const [year,month,day] = value.split('-');
    const variants = [value, ...['/','.', '-'].flatMap(separator => [...new Set([day,String(Number(day))])].flatMap(d => [...new Set([month,String(Number(month))])].map(m => d + separator + m + separator + year)))];
    const documentDateLabel = /(?:data\s+(?:(?:da|de|do)\s+)?(?:realiza[cç][aã]o(?:\s+(?:do|de)\s+exame)?|coleta|exame)|realiza[cç][aã]o(?:\s+(?:do|de)\s+exame)?|coleta|exame\s+realizado|realizad[oa]|coletad[oa]|data\s+(?:(?:da|de|do)\s+)?(?:laudo|emiss[aã]o|assinatura)|laudo(?:\s+(?:emitido|realizado|assinado))?|emiss[aã]o|emitido|assinatura|assinado)(?:\s+em)?\s*[:=-]?\s*$/iu;
    const page = context.pages[ev.page - 1], indexedExcerpt = indexed(ev.excerpt);
    for (const variant of variants) for (const at of occurrences(ev.excerpt, variant)) {
      // The label must immediately qualify this date, not some other date in the quote.
      const rawStart = ev.start + indexedExcerpt.starts[at];
      const prefix = page.slice(Math.max(0, rawStart - 160), rawStart);
      const label = prefix.split(/\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|[;.!?]/u).at(-1);
      if (/\b(?:receb(?:ido|imento)|nascimento|nascido|n[aã]o)\b/iu.test(label)) continue;
      if (documentDateLabel.test(normalized(label))) return true;
    }
    return false;
  }

  function supportsRequester(ev, value, field) {
    const quote = normalized(ev.excerpt);
    const label = /(?:solicitante|requisitante|solicitad[oa]\s+por)\s*[:=\-]?\s*(?:(?:dr|dra|doutor|doutora)\.?\s+)?$/iu;
    const genericLabel = /m[eé]dic[oa]\s+veterin[aá]ri[oa]\s*[:=\-]?\s*(?:(?:dr|dra|doutor|doutora)\.?\s+)?$/iu;
    const otherRole = /(?:laudante|radiologista|assinad[oa]|assinatura|signat[aá]rio|liberad[oa]\s+por|\bRT\b|respons[aá]vel\s+(?:(?:pelo|do)\s+laudo|t[eé]cnico))/iu;
    const table = identificationTable(ev.excerpt);
    const inlinePatient = fields.pet_name && occurrences(quote,fields.pet_name).some(at => /\b(?:paciente|pet|animal|nome\s+do\s+paciente)\s*[:=\-]\s*$/iu.test(quote.slice(0,at)));
    const inlineGuardian = fields.client_name && occurrences(quote,fields.client_name).some(at => /\b(?:respons[aá]vel|tutor(?:a)?)\s*[:=\-]\s*$/iu.test(quote.slice(0,at)));
    const inlineCollection = /\b(?:data\s+(?:(?:da|de)\s+)?)?coleta\s*[:=\-]\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2})\b/iu.exec(quote);
    const patientMatches = fields.pet_name && (table.patient ? comparable(table.patient) === comparable(fields.pet_name) : inlinePatient);
    const guardianMatches = fields.client_name && (table.guardian ? (table.guardianColumnar
      ? comparable(table.guardian) === comparable(fields.client_name)
      : comparable(table.guardian).startsWith(comparable(fields.client_name) + ' ')
        && /\p{L}/u.test(comparable(table.guardian).slice(comparable(fields.client_name).length).trim())) : inlineGuardian);
    const identification = data.single_patient && quote.length <= 1500 && !otherRole.test(quote)
      && patientMatches && guardianMatches
      && (table.collectionDate || (inlineCollection && printedDateISO(inlineCollection[1])));
    const contextualName = name => identification && (table.vetName
      ? comparable(table.vetName) === comparable(name)
      : table.vetValues ? comparable(table.vetValues).endsWith(' ' + comparable(name))
        && /\p{L}/u.test(comparable(table.vetValues).slice(0,-comparable(name).length).trim())
      : occurrences(quote, name).some(at => genericLabel.test(quote.slice(0, at))));
    if (field === 'requesting_vet_name') {
      return occurrences(quote, value).some(at => label.test(quote.slice(0, at))) || contextualName(value);
    }
    // A registration belongs to the requester only when the same bounded quote
    // explicitly names that requester. A report signature is a different role.
    if (!fields.requesting_vet_name || !/\b(?:[A-Z]{2}\s*[-/]?\s*\d{3,8}|\d{3,8}\s*[-/]?\s*[A-Z]{2})\b/iu.test(value)) return false;
    if (contextualName(fields.requesting_vet_name) && (table.vetRegistration
      ? occurrences(table.vetRegistration,value).length > 0
      : occurrences(quote, fields.requesting_vet_name).some(at => occurrences(quote,value).some(regAt => regAt > at)))) return true;
    return quote.length <= 500 && occurrences(quote, fields.requesting_vet_name).some(at =>
      label.test(quote.slice(0, at)) && occurrences(quote, value).some(regAt => regAt > at)
      && !/(?:laudante|radiologista|assinado|signat[aá]rio|respons[aá]vel\s+(?:(?:pelo|do)\s+laudo|t[eé]cnico))/iu.test(quote));
  }

  function hemogramEvidence() {
    if (data.classification === 'not_exam' || !data.single_patient) return null;
    const value = data.fields.exam_type;
    // A named non-haematological panel or a combined order keeps its own type.
    // Only an absent type or these haematology names may be normalized.
    if (value != null && (!meaningful(value) || !/^(?:hemograma(?:\s+completo)?|eritrograma|leucograma|plaquetograma|creatinina|ur[eé]ia)(?:\s*(?:[,;/+&]|\be\b)\s*(?:hemograma(?:\s+completo)?|eritrograma|leucograma|plaquetograma|creatinina|ur[eé]ia))*$/iu.test(normalized(value)))) return null;
    const column = '(?:resultados?|valor(?:es)?(?:\\s+de\\s+refer[eê]ncia)?|refer[eê]ncia|unidades?|par[aâ]metros?|s[eé]rie\\s+(?:vermelha|branca)|relativo|absoluto|valor\\s+(?:rel|abs)\\.\\s+ref\\.)';
    const heading = new RegExp('^(?:(?:\\d{1,2}|[ivx]{1,5})\\s*[.)\\-–—]?\\s+)?(eritrograma|leucograma|plaquetograma|creatinina|ur[eé]ia)\\s*(?:[:：\\-–—]\\s*)?(?:' + column + '(?:(?:\\s+|\\s*\\|\\s*)' + column + ')*)?$', 'iu');
    const historicalHeading = /^(?:hist[oó]rico(?:\s+[^:]+)?|antecedentes|(?:resultados?|exames?)\s+anteriores?|resultados?\s+(?:do|de)\s+exame\s+anterior|compara[cç][aã]o\s+(?:com\s+)?exames?\s+anteriores?|bibliografia|refer[eê]ncias?\s+(?:bibliogr[aá]ficas?|hist[oó]ricas?)|exemplo|modelo|(?:exames?|resultados?)\s+n[aã]o\s+realizados?|n[aã]o\s+realizad[oa]s?|exames?\s+solicitados?|solicita[cç][aã]o\s+de\s+exames?|exames?\s+a\s+realizar)(?:\s*[:=\-–—].*)?$/iu;
    const currentHeading = /^(?:resultados?\s+atuais?|exames?\s+atuais?|resultado\s+do\s+exame|dados\s+atuais|laudo\s+atual)\s*[:=\-–—]?$/iu;
    const unavailableHeading = /^(?:(?:exames?|resultados?)\s+)?n[aã]o(?:\s+(?:foi|foram|ser[aá]|ser[aã]o))?\s+realizad[oa]s?\s*[:=\-–—]?$/iu;
    const unavailable = /\b(?:(?:n[aã]o(?:\s+(?:foi|foram|ser[aá]|ser[aã]o|h[aá]|houve|[eé]|s[aã]o))?(?:\s+poss[ií]vel)?|sem)\s+(?:realiz(?:ad[oa]s?|a[cç][aã]o|ar)|solicitad[oa]s?|resultados?|dados|material)|cancelad[oa]|pendente|anteriores?|hist[oó]ric[oa]s?|bibliogr[aá]fic[oa]s?)\b/iu;
    const found = new Map(); let historical = false, unknownPanel = false;
    for (let page = 0; page < context.pages.length; page++) {
      const lines = context.pages[page].split(/\r\n?|\n/u);
      for (let row = 0; row < lines.length; row++) {
        const line = normalized(lines[row]);
        if (historicalHeading.test(line) || unavailableHeading.test(line)) { historical = true; continue; }
        if (currentHeading.test(line)) { historical = false; continue; }
        const match = heading.exec(line);
        if (!match && !historical && /^[\p{L}][\p{L}\p{N} ()/\-]{1,80}\s+Resultado\s+Refer[eê]ncia$/iu.test(line)) unknownPanel = true;
        if (!match || historical || unavailable.test(line)) continue;
        // A title followed by "não realizado" is not a completed section.
        // Stop at another title, so its qualifier cannot invalidate this one.
        let following = '';
        for (let next = row + 1; next < Math.min(lines.length, row + 4); next++) {
          const nextLine = normalized(lines[next]);
          if (heading.test(nextLine) || currentHeading.test(nextLine)) break;
          if (unavailableHeading.test(nextLine)) { following += ' ' + nextLine; break; }
          if (historicalHeading.test(nextLine)) {
            if (/n[aã]o\s+realizad/iu.test(nextLine)) following += ' ' + nextLine;
            break;
          }
          following += ' ' + nextLine;
        }
        if (unavailable.test(following)) continue;
        const section = comparable(match[1]).normalize('NFD').replace(/\p{M}/gu,'');
        if (!found.has(section)) found.set(section, {field:'exam_type',page:page + 1,excerpt:lines[row].trim()});
      }
    }
    if (unknownPanel || !['eritrograma','leucograma','plaquetograma'].every(section => found.has(section))) return null;
    const components = ['eritrograma','leucograma','plaquetograma',...['creatinina','ureia'].filter(section => found.has(section))];
    return {value:['Hemograma',...['creatinina','ureia'].filter(section => found.has(section)).map(section => section === 'creatinina' ? 'Creatinina' : 'Ureia')].join(' + '), evidence:components.map(section => found.get(section))};
  }

  const fields = {}, evidence = [], invalid = [];
  const candidates = data.evidence.flatMap(locateEvidence);
  const hemogram = hemogramEvidence();
  for (const field of allowed) {
    if (field === 'exam_type' && hemogram) {
      fields.exam_type = hemogram.value; evidence.push(...hemogram.evidence); continue;
    }
    if (!Object.hasOwn(data.fields, field)) continue;
    const value = data.fields[field];
    if (value === null) { fields[field] = null; continue; }
    const valid = meaningful(value) && candidates.filter(ev => ev.field === field).find(ev => field === 'exam_date' ? supportsDate(ev, value) : field.startsWith('requesting_vet_') ? supportsRequester(ev, value, field) : occurrences(ev.excerpt, value).length > 0);
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
    review_reason:reasons.join('; ') || null, extractor_version:'document-evidence-v5',
  };
}
