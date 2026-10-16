# Operational exam workflow templates

These public templates contain examples only. They have no mailbox, project identifier, Drive folder, group identifier or real credential reference. They are inactive, `enabled:false`, have no cutoff, and disable all four execution-saving options.

The four files represent one operational process:

| Template | Responsibility |
|---|---|
| `OPERACIONAL-01.json` | Gmail PDF attachments → stable source reservation → Drive upload/readback → document queue |
| `OPERACIONAL-02.json` | PDF text → evidence-backed fields or manual review → filename and identification |
| `OPERACIONAL-03.json` | One PDF notification to a verified Chatwoot group; read-only delivery reconciliation |
| `OPERACIONAL-04.json` | Attach a confirmed patient's PDF through the existing backend |

They use the existing `reserve_source`, `stage_file`, `confirm_file`, `source_error`, `extraction`, `reserve_tasks`, `task_result`, `reconcile` and `attach_nexus` actions. They contain no collection journal or temporary production authorization. The corresponding operational backend migration must be installed before activation; configuration and the legacy importer cutover remain separate administrative steps.

## Public versus private configuration

The four JSON files are the reusable template sources. The builder reads them, preserves the graph/Codes/HTTP contracts and injects configuration into a **private output directory outside this public repository**. Never replace these committed templates with bound output.

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

## Operation and recovery

Use an agreed ISO cutoff for both intake and notifications, replace the old importer for that window, and then enable the existing operational configuration and four schedules together. Each template offers a manual trigger and a five-minute schedule. A selected `manualMessageId` in intake uses the same MIME/source/Drive path; the schedule refuses to run while this field is populated. Clear it before operational scheduling.

The mailbox may contain nonclinical PDFs. Intake preserves them even when sender or patient names are unknown. `dedicatedMailbox:false` records unknown senders rather than treating the mailbox as trusted. `metadata.exam_candidate` is derived only from clinical hints in the Subject header, never the body or sender; the observed sender and allowlist result are preserved. Gmail queries use a 60-second transport margin and exact `internalDate` checks. The fixed cutoff is rescanned instead of advancing a watermark; source identity and hash/size prevent duplicate saved files. Pagination is checked before processing. Failed attachments return to the loop and can be recovered on the next scan.

A Drive ID is persisted before upload. Recovery reads the same ID and verifies parent, properties and bytes; conflicting bytes are not overwritten. Lost confirmation is reconciled by reading the saved source on the next scan. `reconcile` releases expired processing/attachment leases. Group HTTP success means submission, not delivery: only provider `delivered`/`read` or audited human confirmation completes that stage. An uncertain result never triggers another automatic message POST.

The operational backend allows group delivery only for a subject-based exam candidate, supported clinical extraction or explicit human exam review. Other PDFs remain preserved and pending rather than being sent immediately. Processing validates PDF page/value evidence; a unique exact patient/tutor match can enqueue attachment. Missing or ambiguous identity remains visible for manual selection and confirmation. The attachment backend verifies patient/date, copies private bytes, checks their hash and writes the existing clinical attachment idempotently.

## Limits and checks

Intake limits are 20 MiB per PDF, MIME depth 8 and 100 pages of 100 Gmail message references. Incomplete/cyclic pagination fails visibly. Cost grows with the fixed-cutoff history; changing a window requires reconciling pending sources first. Inline PDFs without attachment IDs, oversized files and unsupported input remain pending. Spam and Trash are excluded explicitly by default.

Text processing allows 100 pages and 80,000 characters. Scanned/protected/empty PDFs, extraction errors and invalid model evidence fall back to review; this package has no OCR. Group reconciliation reads at most 20 pages, then leaves unproven delivery for manual checking. No originals, Gmail labels/messages or records are deleted.

```sh
node --test scripts/exames/operacional-workflows.test.mjs
```

The 12 functional tests run Code/expressions in VM and check graph/contracts, pagination, partial failure, nested-loop reset, canonical deduplication, upload recovery, extraction review and uncertain delivery. An additional test checks private configuration/output restrictions and keeps public templates neutral. Optional `OPERACIONAL_PARSER_PACKAGE` points to an already-installed local n8n package for Tournament parsing, without installing dependencies. The 74 expressions were checked with n8n-workflow 2.10.1/Tournament 1.0.6.

These checks do not execute the n8n engine or prove OAuth, model, Drive, Chatwoot or production-database operation. Validate the configured workflow separately before operational activation.
