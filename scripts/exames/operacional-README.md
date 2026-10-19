# Operational exam workflow templates

These public templates contain examples only. They have no mailbox, project identifier, Drive folder, group identifier or real credential reference. They are inactive, `enabled:false`, have no cutoff, and disable all four execution-saving options.

The first four files represent one scheduled operational process, with an optional WhatsApp intake:

| Template | Responsibility |
|---|---|
| `OPERACIONAL-01.json` | Gmail PDF attachments → stable source reservation → Drive upload/readback → document queue |
| `OPERACIONAL-02.json` | PDF text → evidence-backed fields or manual review → filename and identification |
| `OPERACIONAL-03.json` | One PDF notification to a verified Chatwoot group; read-only delivery reconciliation |
| `OPERACIONAL-04.json` | Attach a confirmed patient's PDF through the existing backend |
| `OPERACIONAL-05.json` | Authorized incoming WhatsApp PDFs → API verification → the same Drive and document queue |

They use the existing `reserve_source`, `stage_file`, `confirm_file`, `source_error`, `extraction`, `reserve_tasks`, `task_result`, `reconcile` and `attach_nexus` actions. They contain no collection journal or temporary production authorization. The corresponding operational backend migration must be installed before activation; configuration and the legacy importer cutover remain separate administrative steps.

## Public versus private configuration

The first four JSON files are the reusable sources for `operacional-build.mjs`; the optional fifth template uses `whatsapp-intake-build.mjs`. The builders preserve their graph/Code/HTTP contracts and inject configuration into **private output outside this public repository**. Never replace these committed templates with bound output.

Create a private file outside the repository, for example `../private-exams/config.local`. Use only operational configuration and credential **references**, never passwords, API keys, tokens, headers or secret values. A partial example:

```json
{
  "config": {
    "enabled": false,
    "serviceUrl": "https://YOUR_PROJECT.supabase.co/functions/v1/exam-document-service",
    "mailbox": "exams@example.invalid",
    "driveFolderId": "YOUR_VERIFIED_PRIVATE_FOLDER",
    "intakeCutoff": "",
    "notificationCutoff": "",
    "chatwootBaseUrl": "https://chatwoot.example.invalid",
    "accountId": 1,
    "inboxId": 1,
    "conversationId": 1,
    "groupJid": "YOUR_VERIFIED_GROUP@g.us",
    "pamLaudosBaseUrl": "https://exams.example.invalid"
  },
  "credentials": {
    "gmail": {"id": "EXISTING_GMAIL_CREDENTIAL_ID", "name": "Existing Gmail OAuth"},
    "drive": {"id": "EXISTING_DRIVE_CREDENTIAL_ID", "name": "Existing Drive OAuth"},
    "worker": {"id": "EXISTING_WORKER_CREDENTIAL_ID", "name": "Existing worker header"},
    "chatwoot": {"id": "EXISTING_CHATWOOT_CREDENTIAL_ID", "name": "Existing Chatwoot credential"},
    "extractor": {"id": "EXISTING_OPENAI_CREDENTIAL_ID", "name": "Existing OpenAI credential"}
  }
}
```

```sh
node scripts/exames/operacional-build.mjs \
  --config ../private-exams/config.local \
  --out ../private-exams/workflows
```

Bound output is written with mode `0600`. The CLI refuses configuration or bound output inside the public repository. An external file is outside Git's tracked tree; keep private files out of the repository rather than relying on Git ignore alone. Unknown configuration fields and credential properties other than `id`/`name` are rejected. The builder prints only output paths, node counts and hashes.

Running the builder without `--config` reproduces neutral templates. No network call, credential creation, workflow import or activation occurs.

## Optional WhatsApp intake

`OPERACIONAL-05.json` is a neutral, inactive template with `enabled:false`, no authorized sender and no real webhook path or credential references. Its presence in Git does not mean it has been installed, activated or verified in production. Configure account/inbox, `authorizedSenders`, the cutoff, `allowedAttachmentOrigins` and `webhookPath` only in a private file outside Git, using existing credential references. Generate the bound file outside the repository:

```sh
node scripts/exames/whatsapp-intake-build.mjs \
  --config ../private-exams/whatsapp.config.local \
  --out ../private-exams/workflows/OPERACIONAL-05.json
```

The webhook is a hint containing IDs, not trusted sender or attachment evidence. The workflow rereads the conversation and exact message through the authenticated Chatwoot API before checking the configured account/inbox, authorized phone and individual incoming conversation. Private notes, outgoing/group messages and internal exam notifications are excluded. Media downloads carry no Chatwoot credential; every URL/redirect must match the configured HTTPS origins. Input is limited to PDF originals of at most 20 MiB (20,971,520 bytes), with MIME, signature, stated size and SHA-256 checks.

Accepted files reuse the existing source reservation, Drive upload/readback and processing/group/Nexus queues. Origin is stored as `whatsapp`; Pam Laudos distinguishes **received through WhatsApp** from **sent to the WhatsApp group**. If email and WhatsApp sources deduplicate into one document, the UI preserves email as its displayed primary origin. Source IDs prevent webhook retries from creating a new origin, and SHA-256 plus byte size merges the same original received through email or another WhatsApp message. Existing sent/submitted/uncertain group deliveries are not reopened.

Missing names or extraction failure do not hold a preserved exam candidate indefinitely: the existing group rules allow review/failure or a bounded processing window. Explicit not-exam rejection, file integrity, destination/cutoff and replay guards remain unchanged; clinical attachment still requires confirmed patient/date. There is no scheduled polling fallback or automatic event replay in template 05. Folder validation and Chatwoot API GETs have up to three attempts. If those reads fail before source reservation, no pending document/card has been created. Only failures after reservation have an existing source/document to recover as pending. Recover explicitly using the original message/conversation IDs from Chatwoot, first checking existing sources and external effects; do not assume a pending card exists. Never blindly replay an uncertain group submission.

```sh
npm run test:exames:whatsapp
```

These runtime and builder tests cover synthetic metadata/bytes, API reread, origin/redirect validation, loop prevention, deduplication contracts and neutral/private configuration. They do not prove live Chatwoot delivery, Drive upload or workflow activation.

## Identification and commercial exam names

The v5 evidence validator reads labelled identity tables as columns, including the collection date and a requesting veterinarian in the patient header. A generic veterinarian label alone or a report signature is insufficient. Registration numbers without a state remain null; names are not completed from a registry. Multiple releasing professionals do not imply multiple patients when the patient and tutor identity is the same across pages.

Eritrograma, Leucograma and Plaquetograma together, as current result sections for one patient, normalize to Hemograma. The validator preserves supported additional Creatinina and/or Ureia sections in the commercial display name, with evidence for every component. Historical mentions, incomplete trios, mixed patients and unrelated named panels do not acquire that normalization. SQL migration16 validates the same evidence before automatic matching; a composite document does not consume an arbitrary individual sales item. Migration17 permits only the contextual requesting-veterinarian header, preserving manual assignment and conflict rules. Migration18 adds explicit full-name aliases for documentary names that differ from a veterinarian’s displayed name. It contains no real alias seed: each equivalence needs separate confirmation. Matching remains exact and active-only; numeric CRMV alone never creates that equivalence, and ambiguous names remain pending.

Regenerating a neutral template does not update the installed n8n workflow or Supabase. Review and install those changes separately. Reprocessing an existing document must retain its source, bytes, clinical decisions and existing group delivery; do not reopen a sent/uncertain delivery.

## Operation and recovery

Use an agreed ISO cutoff for both intake and notifications, replace the old importer for that window, and then enable the existing operational configuration and four schedules together. Each of the first four templates offers a manual trigger and a five-minute schedule. A selected `manualMessageId` in Gmail intake uses the same MIME/source/Drive path; the schedule refuses to run while this field is populated. Clear it before operational scheduling.

The mailbox may contain nonclinical PDFs. Gmail intake preserves them even when sender or patient names are unknown. `dedicatedMailbox:false` records unknown senders rather than treating the mailbox as trusted. Its `metadata.exam_candidate` is derived only from clinical hints in the Subject header, never the body or sender; the observed sender and allowlist result are preserved. The separate WhatsApp intake marks a candidate only after its explicit sender/channel checks. Gmail queries use a 60-second transport margin and exact `internalDate` checks. The fixed cutoff is rescanned instead of advancing a watermark; source identity and hash/size prevent duplicate saved files. Pagination is checked before processing. Failed attachments return to the loop and can be recovered on the next scan.

A Drive ID is persisted before upload. Recovery reads the same ID and verifies parent, properties and bytes; conflicting bytes are not overwritten. Lost confirmation is reconciled by reading the saved source on the next scan. `reconcile` releases expired processing/attachment leases. Group HTTP success means submission, not delivery: only provider `delivered`/`read` or audited human confirmation completes that stage. An uncertain result never triggers another automatic message POST.

The operational backend allows group delivery only for an exam candidate established by the intake policy (Gmail subject hints or the authorized WhatsApp route), supported clinical extraction or explicit human exam review. Other PDFs remain preserved and pending rather than being sent immediately. Processing validates PDF page/value evidence; a unique exact patient/tutor match can enqueue attachment. Missing or ambiguous identity remains visible for manual selection and confirmation. The attachment backend verifies patient/date, copies private bytes, checks their hash and writes the existing clinical attachment idempotently.

## Limits and checks

Intake limits are 20 MiB per PDF, MIME depth 8 and 100 pages of 100 Gmail message references. Incomplete/cyclic pagination fails visibly. Cost grows with the fixed-cutoff history; changing a window requires reconciling pending sources first. Inline PDFs without attachment IDs, oversized files and unsupported input remain pending. Spam and Trash are excluded explicitly by default.

Text processing allows 100 pages and 80,000 characters. Scanned/protected/empty PDFs, extraction errors and invalid model evidence fall back to review; this package has no OCR. Group reconciliation reads at most 20 pages, then leaves unproven delivery for manual checking. No originals, Gmail labels/messages or records are deleted.

```sh
node --test scripts/exames/operacional-workflows.test.mjs
```

The 12 functional tests run Code/expressions in VM and check graph/contracts, pagination, partial failure, nested-loop reset, canonical deduplication, upload recovery, extraction review and uncertain delivery. An additional test checks private configuration/output restrictions and keeps public templates neutral. Optional `OPERACIONAL_PARSER_PACKAGE` points to an already-installed local n8n package for Tournament parsing, without installing dependencies. The 74 expressions were checked with n8n-workflow 2.10.1/Tournament 1.0.6.

These checks do not execute the n8n engine or prove OAuth, model, Drive, Chatwoot or production-database operation. Validate the configured workflow separately before operational activation.
# Veterinária responsável

A responsabilidade clínica usa o cadastro de veterinários ativos, separado do usuário autenticado que registra a ação. A seleção manual tem prioridade e também atualiza os cards efetivamente ligados ao documento; ela não altera a autoria original da venda nem cria acessos.

Novos PDFs podem identificar a solicitante por trecho documental explícito. A assinatura de quem emitiu o laudo não é usada como solicitante. A venda contribui quando o documento corresponde a um único item pendente do mesmo paciente, tutor e tipo de exame. Duas correspondências ou fontes divergentes deixam a escolha para a equipe. A falta de responsável não bloqueia a entrega do PDF.

A migração `20261018000012_exam_document_responsibility.sql` preserva os contratos implantados e acrescenta os campos `responsible_vet_*` à consulta e à tarefa do grupo. Não reprocessa documentos antigos nem reinicia entregas. Após instalar essa migração, atualizar os nós revisados de OP02/OP03 e a interface. Não executar novamente os envios para testar uma legenda.

O seletor antigo do CRM pode conter um nome diferente do seu ID clínico. Essa divergência também exige seleção manual na página do exame; a automação não escolhe silenciosamente um dos dois valores. A escolha na página do exame grava ID e nome juntos, registra o autor e preserva o veterinário original da venda.

Validação direcionada: `npm run test:exames:responsavel`.

## Resumo diário dos pendentes

`OPERACIONAL-06.json` agenda o resumo às 08h em `America/Sao_Paulo`, todos os dias. Instale a migração `20261018000013_exam_pending_summary.sql` e publique as ações correspondentes do `exam-document-service` antes de ativá-lo. O template público é inativo e sem credenciais; gere o vínculo em arquivo privado externo com `pending-summary-build.mjs --config … --out …`.

A consulta usa documentos canônicos já entregues ao grupo configurado e com contato ainda aberto, incluindo contato parcial. Exclui fixtures e rejeitados. O texto mostra os nomes disponíveis, tempo desde a entrega confirmada, responsável clínica definida e link do exame. Sem pendentes, não envia mensagem. Não reenvia PDFs nem altera contato ou vínculo clínico.

A reserva é única por dia local e destino. O banco concede a autorização para o POST uma única vez, entre 08h e 09h; resposta perdida ou incerta não libera outro envio. O resultado fica em `exam_pending_summary` e seu histórico privado. Uma falha exige conferir esse registro e o histórico do Chatwoot antes de qualquer recuperação. Não executar novamente um envio incerto.

`OPERACIONAL-06-PREVIEW.json` consulta a mesma lista e verifica o grupo/histórico sem reservar ou enviar. Use essa prévia para conferência manual fora da janela. Listas acima de 200 documentos, resumos acima de 12.000 caracteres ou paginação incompleta falham explicitamente; nenhum item é cortado silenciosamente. A primeira execução da agenda continua sendo uma validação distinta da prévia.

Verificações direcionadas: `node --test scripts/exames/pending-group-summary.test.mjs scripts/exames/pending-summary-runtime.test.mjs scripts/exames/pending-summary-build.test.mjs`, `node supabase/tests/exam-pending-summary.test.mjs` e `node supabase/tests/exam-document-service.test.mjs`.
