# Directed reaction state and idempotent check creation

This additive provider API supports `pamvet_check_v1`. It preserves the existing
Chatwoot `create` action and its toggle route. Consumers must use the two new
paths; an old provider returns 404 and must remain closed to dispatch.

- GET `/api/v1/accounts/:account_id/conversations/:conversation_id/messages/:message_id/reactions/state`
- POST `/api/v1/accounts/:account_id/conversations/:conversation_id/messages/:message_id/reactions/ensure`

Both inherit the existing account/conversation authentication and target guards,
use `Cache-Control: no-store`, and read current rows under the same original-message
lock used by the existing toggle. Neither uses conversation pagination or a saved
row-ID cursor. `ensure_check` reloads the conversation and checks original proof
again after acquiring that lock.

## Contract

State returns:

```json
{
  "contract": "pamvet_check_v1",
  "complete": true,
  "evidence_complete": true,
  "actor_id": 1,
  "scope": {"account_id": 1, "inbox_id": 2, "conversation_id": 23, "message_id": 100, "group_jid": "120000000000@g.us"},
  "original": {
    "id": 100, "message_type": "outgoing", "private": false,
    "status": "delivered", "source_id": "provider-original",
    "content_sha256": "64 lower-case hex characters",
    "content_attributes": {"pamvet_exam_document_id": "uuid", "pamvet_exam_delivery_id": "uuid", "pamvet_exam_sha256": "64 hex"},
    "legacy_reference": null,
    "attachments": [{"id": 51, "file_type": "file"}]
  },
  "own_reactions": [],
  "current_own_reaction_id": null
}
```

No caption, attachment URL, PDF bytes, credentials, contact profile or unrelated
message attributes are returned. `legacy_reference`, when present, is only the
exact trailing `[EXAM:uuid:DELIVERY:uuid]` marker. Partial/conflicting PAM tags
cannot fall back to that marker.

For compatibility, each own row also includes the same safe MessageAPI fields: `content` (emoji only), `private`, and `content_attributes` containing only is_reaction/deleted/parent references.

Every matching OUTGOING support row appears in the legacy-named `own_reactions` array, including other agents, deleted rows and same-number outgoing echoes without a user. All agents share the inbox's external WhatsApp number. `own_scope` distinguishes `actor`, `same_account_echo`, and `other_support`; another User is never proof of the current actor's reaction. Any other-support row (including deleted history) holds ensure without a send. Incoming participant reactions are excluded. Each has `id`, `emoji`,
`invalid_emoji`, `parent_identity_valid`, `deleted`, `status`, `source_id`,
`message_type`, `sender` (`{id,type}` or null), `same_account_echo`, `in_reply_to`
and `in_reply_to_external_id`. An unrecognized reaction text is suppressed as
`emoji:null, invalid_emoji:true`. `current_own_reaction_id` comes from the existing
provider selector; complete means the matching current rows were read, not that
WhatsApp delivery has been confirmed.

Ensure requires:

```json
{
  "contract": "pamvet_check_v1",
  "emoji": "✅",
  "expected": {
    "account_id": 1, "inbox_id": 2, "conversation_id": 23,
    "message_id": 100, "actor_id": 1, "group_jid": "120000000000@g.us",
    "document_id": "11111111-1111-4111-8111-111111111111",
    "delivery_id": "22222222-2222-4222-8222-222222222222",
    "sha256": "64 lower-case hex characters",
    "source_id": "provider-original",
    "content_sha256": "64 lower-case hex characters",
    "attachment_ids": [51]
  }
}
```

Expected scope, actor, original provider ID, caption hash, attachment IDs and
clinical correlation are revalidated inside the lock. Legacy references preserve
the previous OP07 policy without inventing a missing original SHA attribute.

- No existing own row: HTTP201, `action:'created'`, `dispatch_performed:true`.
  Calls the existing MessageBuilder exactly once. Its normal after-create-commit
  path sends the message; this module does **not** queue SendReplyJob again.
- Active own ✅: HTTP200, `action:'already_present'`,
  `dispatch_performed:false`. Includes a pending provider acknowledgment and
  duplicate same-emoji echoes. No update or send occurs.
- Own other emoji, ambiguous parent, removed/deleted choice or ANY other support agent's row: HTTP409,
  `action:'held'`, `dispatch_performed:false`. Existing rows are unchanged.
- Bad contract/emoji: HTTP422. Missing actor: HTTP403. Changed or invalid
  original/scope/reference: HTTP409. Errors have a fixed `error_code`,
  `complete:false`, and `evidence_complete:false`.

A `created` response proves one provider-side row was created, not WhatsApp receipt.
A positive GET after provider acknowledgment is still required for external
confirmation. Existing pending, unknown, other-emoji and deleted states must never
be converted to a retry of the old toggle endpoint.

## Reproduce the thin image

Base image pinned to:

`ghcr.io/fazer-ai/chatwoot@sha256:924c852c0d5a231a4c1b63b0d22a55c0fb5ab899d73eb59986d7ceb5a05ff048`

Installed controller SHA256:
`23992625576e7d53ae7d61659c3aaf3c76b114c5476a8d41c6080edd984fbee8`.
Installed complete routes SHA256:
`f435c6f148d1a178a0cc73aa77b7c0edb32efbe29f2521866e46b071fc0e8353`.

Read the installed files through the authorized host. Keep exports/build context
outside this repository. No credentials are needed in the image.

```sh
node scripts/exames/chatwoot-reaction-guard/build.mjs \
  --source-controller /PRIVATE/installed-source/reactions_controller.rb \
  --out /PRIVATE/provider-guard-candidate
ruby -c /PRIVATE/provider-guard-candidate/reactions_controller.rb
# On the existing Docker host, with the pinned image cached:
docker build --pull=false --network=none -t LOCAL_GUARD_TAG /PRIVATE/provider-guard-candidate
```

The Dockerfile changes only the controller and the two additional routes. No
Rails/npm/bundle build or dependency installation runs. It does not set USER:
the inspected pinned image has Config.User empty (root default), which is inherited
unchanged. Source remains world-readable inside the image. Upstream license and
copyright files remain in the inherited filesystem, and the original controller
body is included unchanged except for inclusion of this module. See the upstream
license already shipped with that base image; no upstream ownership is claimed.

`build.mjs` refuses an unknown controller SHA and output under this repository;
`patch-routes.rb` refuses an unknown routes SHA or nonunique route anchor. Do not
skip those checks after an upstream upgrade.

This directory prepares an image; it does not publish or restart production.
Keep the previous service image/compose configuration for an ordinary rollback.
Validate Rails routes/eager loading in isolation and the real HTTP contract before
pointing OP07 at the new paths. An unavailable API must never fall back to toggle.

## Verification and limits

```sh
ruby scripts/exames/chatwoot-reaction-guard/guard_test.rb
# Regenerate synthetic responses for the JavaScript adapter contract tests:
ruby scripts/exames/chatwoot-reaction-guard/export-fixtures.rb \
  scripts/exames/chatwoot-reaction-guard/contract-fixtures.json
```

The synthetic JSON includes the guard module SHA and no real messages or patient data; consumers should verify that SHA to detect fixture drift. Its actor-check, same-number echo, other-support choice and removed states are serialized by the actual module through the test adapter.

These tests execute the actual guard module, with small Rails/model doubles and
a real Ruby Mutex standing in for the original-row lock. They cover two concurrent
ensures, manual ✅ between GET and ensure, pending acknowledgment, removed/other
emoji, same-account echoes, changed original/scope/actor, private/invalid parents,
and legacy references. They do not exercise PostgreSQL/ActiveRecord transactions,
MessageBuilder callbacks, provider delivery or actual Rails route recognition.
Those integration checks remain necessary on the pinned image before deployment.

Atomicity covers the provider's target-row lock, including the existing UI toggle
controller. A WhatsApp action on a separate device, its asynchronous incoming echo,
or an external provider mutation may arrive outside that lock and must retain its
normal reconciliation rules; this is not a global distributed lock over WhatsApp.
