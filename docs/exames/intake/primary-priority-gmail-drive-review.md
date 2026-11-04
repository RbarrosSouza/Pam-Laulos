# Primary intake priority and Gmail/Drive recovery

Reviewed on 2026-11-04. The primary Gmail/PamSuporte workers retain priority; preserving a backup does not authorize sending it to the group.

## Dispatch policy

Migration 46 keeps early private preservation at 120 seconds. Alternative group dispatch requires a current primary failure after the last verified progress, or at least 600 seconds without progress. A valid primary Drive/processing lease protects that work until 1,800 seconds without verified progress. Neither worker heartbeats, renewed leases, source rediscovery, retries, human edits nor fallback preservation reset the progress clock.

The policy runs when reserving the group task and again immediately before the one-shot provider dispatch grant. If the primary resumes between these steps, its task returns to pending without consuming a group attempt. Active group leases and sent/submitted/uncertain deliveries keep their existing fencing and reconciliation. Audit events store the reason, relevant progress/failure times and applicable limits. Waiting for the primary retries after 60 seconds rather than increasing the failure backoff.

## Gmail/Drive repair

The workflow patch checks a previously reserved Drive object before downloading a new provider copy. It verifies the Drive account ownership, parent, document binding, stored fingerprint, exact size and readback hash. A completed upload whose confirmation was lost can therefore finish using the same original and ID even when a provider link now regenerates different bytes. Empty/missing objects return to the original provider route. Conflicting bytes never replace the reserved original.

Errors are classified into bounded stage codes rather than copying provider responses, signed URLs or credentials. Migration 47 adds service-only retry state and wraps the existing source reservation without changing its Gmail/Hopelab identity, hold or tombstone contracts. Cooldown is 5/10/20/40/60 minutes. Concurrent failure callbacks do not extend an active cooldown or duplicate its event. Alternate authorized WhatsApp origins remain available. Late errors cannot degrade a saved original, a canonical saved document, a deleted record or a human not-exam decision. Retry rows follow deletion through their foreign key.

## Deployment and verification

Build candidates from the current private OP01 and prospective Gmail child exports with `buildGmailDriveRecoveryCandidate`. Only their nodes/connections change; existing IDs, configuration, credential references and settings are preserved. Private exports and bound candidates do not belong in this repository. Apply migration 47 before publishing those workflows. Publish through the running n8n editor; the installed CLI version's publish command requires a restart and is unsuitable for a hot update.

Release validation: 118 tests passed, one optional private-export check was skipped, Deno check passed, and the application build passed. Relevant checks:

- SQL tests exercise primary progress, explicit failure, start/idle limits, maximum stagnation, active group protection, canonical aliases, pre-POST resumption, browser access denial and the interaction of retry state with fallback policy.
- Runtime tests exercise lost Drive confirmation followed by regenerated provider bytes, corrupt/missing/empty objects, multi-attachment identity, stage diagnostics and pending receipts during cooldown.
- Existing transport/authentication/collector/scheduler tests retain one-shot sending and lost-response reconciliation.
- Deno check validates the published fallback bundle; the application build validates repository integration.

## Limits

This fixes a reproducible provider-first recovery defect. Missing historical execution details do not establish that it caused every previous generic Gmail/Drive error. An empty reserved Drive object plus unavailable or conflicting provider bytes remains an explicit pending original; it cannot be recovered by inventing or replacing bytes. The n8n task runner/database latency requires separate operational observation. No existing clinical PDF is replayed to demonstrate the change, and a new real end-to-end arrival remains distinct from local regression tests and publication verification.
