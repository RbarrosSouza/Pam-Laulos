import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { examPresentation } from '../../../scripts/exames/notification-presentation.mjs';

export function generatedExamPresentationSource() {
  return '// Generated from scripts/exames/notification-presentation.mjs. Do not edit by hand.\n'
    + '// Regenerate with node supabase/functions/exam-whatsapp-fallback/generate-exam-presentation.mjs\n'
    + "import { Buffer } from 'node:buffer';\n\nexport " + examPresentation.toString() + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL('./exam-presentation.generated.mjs', import.meta.url), generatedExamPresentationSource());
}
