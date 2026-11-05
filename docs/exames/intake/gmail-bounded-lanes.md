# Gmail intake with bounded current and historical lanes

This replaces repeated full-history OP01 polling with the existing durable audit/receipt/CAS pipeline. It does not fix VPS CPU availability or change document identity, Drive integrity, delivery fencing, destinations or notification cutoffs.

The factory reads three verified private exports: current OP01, the published per-message Gmail child, and the published prospective Gmail collector. It never reads credential values. Generated bound workflows must remain outside the repository.

- **Current:** explicit handoff minus five minutes, schedule every five minutes. Enumeration runs before a maximum of one pending-origin recheck per window. The recheck cursor survives between windows.
- **History:** the OP01 original cutoff through a frozen handoff, schedule every fifteen minutes. Windows never exceed one day. Failed coverage intervals remain explicit round-robin gaps. Reaching the handoff does not abandon pending originals: the same collector continues bounded rechecks without re-enumerating history. Only an empty pending first page proves no originals remain pending; an empty tail only resets the cursor.
- **Both:** separate collector identities/state rows, the existing fifteen-minute CAS lease, maximum 100 operations/180 seconds per tick, thirty-second HTTP timeouts, 180-second child and 300-second parent engine timeouts. A late child call yields the persisted pending bridge rather than starting without sufficient budget. The child may preserve a PDF but never sends it to the group.

The historical upper bound is part of the local state identity and collector ID. The existing backend scope-manifest shape is unchanged. Per-window coverage ACKs remain distinct from historical recovery completion. Existing `coverageHadGap` history is retained and never fabricated as a global backend proof.

## Prepare and publish

Use `scripts/exames/intake/gmail-stability-build.mjs`. Its exports are `gmailStabilityLanes`, `buildGmailStabilityChild`, `buildGmailStabilityParent`, `readGmailCollectorConfig`, and `writeGmailStabilityCandidates`. The CLI takes private `--primary-export`, `--child-export`, `--collector-export`, `--data-table-id`, canonical UTC `--handoff`, and external `--out`.

0. Before either parent schedule is enabled, seed exactly one private Data Table row per new collector: `collector_key` from the manifest, `revision: 0`, and the string `state_json: 'null'`. Read back exactly one row for each key. This permits the native revision-CAS update from the first run; without bootstrap, two first runs could insert duplicate rows and only fail closed. Do not alter the shared Data Table schema or replace an existing collector row.
1. Freeze one handoff and generate the two inactive children. Review source/config/credential preservation; create them through authenticated n8n API and read back their actual IDs and settings.
2. Regenerate with `--history-child-id` and `--fresh-child-id`. Review and publish the two parents, preserving privacy settings `none` and checking the persisted engine timeouts explicitly. Existing n8n saves may omit settings; source templates are not proof of live settings.
3. Read back published nodes, connections, collector identities, Data Table ID, child IDs, timeouts and schedules. Only after both new parents are published and verified, pause the old OP01 and old prospective Gmail schedules. Preserve their workflows, running-job evidence, state rows, receipts and clinical documents.
4. Point `attention_gmail_collector_id` at the new current collector. Do not enable monitoring or historical alerts without an explicit baseline.
5. Verify genuine scheduled progress. Successful API publication alone does not validate latency, coverage or clinical delivery. A 70% CPU-steal host can still miss the workflow budgets; do not compensate with more concurrency.

Do not change the historical cutoff to a rolling 24-hour lookback. Do not use `staticData` as a lock, delete old pending receipts, or replay a group send to validate this change. If a child times out during Drive upload, the persisted Drive ID/hash/readback path must reconcile that same original on the next attempt.

## Verification

`node --test scripts/exames/intake/gmail-stability.test.mjs scripts/exames/intake/n8n-discovery-audit.test.mjs scripts/exames/intake/gmail-drive-recovery.test.mjs`

Tests include independent fresh progress, bounded historical windows, final gaps, pending-original recovery after enumeration, durable continuation and lost ACKs, saved-original lookup without another child, exact child identity/config guards, and private-output path enforcement.
