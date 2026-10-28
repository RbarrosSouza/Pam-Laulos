# Coverage panel — incremental migration25

Current operation is panel-only, per the user's decision on 28/10/2026. Errors and pending receipts remain visible in the entry/receipts page; no operational WhatsApp alert dispatcher is included. Applied outbox structures remain for compatibility and history. See [current scope](Panel-only-operation.md).

Requires migrations23 and24. Replaces only `get_exam_intake_panel(integer)`; its member guard, owner and ACL remain. No collector, checkpoint, source, document, hold or alert is mutated. Limit must be1–200, including rejection of null. The old panel fields remain for compatibility.

`contract: exam_intake_panel_v2`. `collectors[]` retains health fields and adds `checkpoint:{received_through,revision}` and `latest_sweep:{id,mode,status,received_from,received_through,started_at,finished_at,coverageComplete,allPreserved,scanFinished,counts}`. Proof booleans remain null before finish; a complete audit does not advance the operational checkpoint.

`summary` contains `notification_cutoff`, `cutoff_configured`, `entries_without_document_total`, `unresolved_origin_total`, `saved_without_group_total`, `group_uncertain_total`, `pending_alert_total`, `version_hold_total`, and `received_at_unknown_total` (the latter counts unbound entries lacking a received timestamp). Without a configured cutoff the panel cannot distinguish old history; `cutoff_configured:false` must stay visible.

Every queue has its total and has-more flag from the exact same population:

| List | Total | Has more |
|---|---|---|
| entries_without_document | entries_without_document_total | entries_without_document_has_more |
| unresolved_origins | unresolved_origin_total | unresolved_origins_has_more |
| saved_without_group | saved_without_group_total | saved_without_group_has_more |
| group_uncertain | group_uncertain_total | group_uncertain_has_more |
| pending_alerts | pending_alert_total | pending_alert_has_more |
| version_holds | version_hold_total | version_hold_has_more |

Entries mean discovered messages without a proved document binding in any receipt; that is not proof of absence from the entire clinical system. Repeated sweep observations are deduplicated per collector/partition/message. Explicit empty manifests and messages whose receipts are all excluded do not inflate this queue. Origins are receipts in discovered/pending/failed. Unknown timestamps stay visible in the current queue; they cannot be classified as historical.

Saved-without-group documents are canonical saved originals without any sent/waived group receipt, a not-exam decision, a group exception or an explicit synthetic fixture. A held version remains visible. Multiple group destination records never multiply the document count. Uncertain is a subset of the same queue. Pending alerts include all outbox states except sent/cancelled, including uncertain submissions requiring receipt confirmation; the panel never dispatches them.

`historical` contains cutoff, `pre_cutoff_entries_without_document{,_total,_has_more}`, `pre_cutoff_unresolved_origins`, its `pre_cutoff_unresolved_origin_total` and `pre_cutoff_unresolved_origins_has_more`, and `pre_cutoff_saved_without_group{,_total,_has_more}`. Historical rows are projected only: viewing them neither alerts nor replays originals. These populations cover the records actually present in the ledger/system, not the unenumerated provider history.

New queue rows expose only selected support/document metadata; no run token, lease token, scope manifest, request ID or alert content digest is returned. Existing receipts and redacted alert fields retain their deployed format.
