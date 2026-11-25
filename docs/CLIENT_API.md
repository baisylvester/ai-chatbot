# Signed-in client API — web, Android, iOS and macOS

Contract version: 1. Client conversations were added November 17, 2026; native onboarding was added November 19. This document is the shared integration contract for web and native clients.

## Release prerequisite

Apply the client conversation, native mail, native onboarding and mail draft migrations through the existing migration runner before deploying the new backend: `20261117090000_client_conversations.sql`, `20261118090000_native_mail.sql`, `20261119075549_native_onboarding.sql`, and `20261119090000_mail_client_drafts.sql`. These were applied to this project's configured shared database on November 19, 2026. Other environments still require their own migrations. The updated API was deployed to https://ai-chatbot-9wg.pages.dev on November 20, 2026; authenticated native onboarding, Gmail Inbox reading and AI writing passed directly from the physical Android device. Fresh-account confirmation-email delivery and the exact Auth redirect/SMTP configuration remain unverified.

Clients must use the same platform URL and Supabase Auth project. A chatbot must be active to start a conversation or send a message. Generic public chatbots allow signed-in users who know their public ID to start their own private conversation, consistent with the platform-hosted widget. Native personal assistants are assigned by onboarding and additionally require their owner; knowing their public ID does not grant access. Neither flow grants access to another user's conversation.

## Authentication

Every `/api/v1/client/*` endpoint requires the signed-in user's Supabase **access JWT**:

```http
Authorization: Bearer <supabase-user-access-token>
```

The backend verifies the token signature, issuer and authenticated audience and derives the owner from `sub`. Do not send an owner/user ID in request bodies. Do not use a private `cbk_…` organization key, Supabase service-role key or anonymous widget session token. Refresh the user token through Supabase Auth independently of conversations; token refresh must never create a new conversation.

Native Kotlin/Swift requests should omit `Origin`. Browser requests with an Origin still enforce the chatbot's domain allowlist, with the platform's own origin allowed. The first-party web app can use its existing session cookies; cross-origin cookie requests are refused. External web clients must provide a user token, supplied by their authenticated host integration. CORS does not permit cross-origin cookies.

Responses have `Cache-Control: private, no-store`. `X-Authenticated-User` identifies the verified account, allowing the web SDK to detect account switching. This header is exposed through CORS. Clear rendered messages, local transcript caches, cursors and selections when changing account. Namespace persisted selections by account, platform and chatbot.

## Endpoints

| Method | Path (prefix `/api/v1/client`) | Body/query | Result |
|---|---|---|---|
| POST | `/onboarding` | No body | `{chatbotId}`; provisions or reuses the authenticated user's private assistant |
| GET | `/chatbots/{chatbotId}` | Public `cb_…` ID | Public name, welcome message, suggested questions, theme and voice configuration |
| GET | `/conversations` | `chatbotId`; optional `before` | `{conversations, nextCursor}`; at most 50, newest creation first |
| POST | `/conversations` | `{id, chatbotId}` | Conversation; `id` is a client-generated UUID retained on retries |
| GET | `/conversations/{id}` | — | Conversation metadata and last turn state |
| GET | `/conversations/{id}/messages` | `after=0`, then returned `nextCursor` | Message page, at most 100 messages |
| POST | `/conversations/{id}/messages` | `{requestId, message, stream?:false}` | `{turn}` after the reply/status is committed |
| DELETE | `/conversations/{id}` | — | 204; deletes transcript and turn records on the server |

### Unified personal assistant

Private native personal assistants use the deployed assistant provider for general conversation even when `emailManager` is false. This avoids retaining a PC-local model from an older account setup. The flag still controls Gmail capability: owner/admin authorization and an active connection are required before tools are attached. General chat without tools does not require Gmail. Public chatbots retain their own model settings. This routing update was deployed and verified on 20 November 2026.

### Shared native knowledge

The signed-in chatbot configuration response includes optional `knowledge` metadata: `state` (`ready`, `processing`, `empty`, `unavailable`), `sourceChatbotId`, `sourceName`, `shared`, source/document/chunk counts and `updatedAt`. An unavailable state can omit the remaining fields. The response stays private and uncacheable.

Native personal assistants resolve `NATIVE_KNOWLEDGE_CHATBOT_ID` to an active published chatbot and use its existing assigned sources on every retrieval. This shares current knowledge without copying documents or changing the assistant's private conversation or Gmail ownership. Private native assistants cannot be used as shared sources. Other published chatbot conversations retain their own source scope. Ready knowledge changes apply after ingestion; unassigned/deleted documents stop participating in later requests. Historical answers are not rewritten.

Standalone Write and Reply use relevant facts from the same configured published knowledge. Supplied-text Summary, Grammar and Translate do not add external knowledge. General questions unrelated to retrieved material can still be answered as general conversation; source-specific facts must be grounded and cited.

### Native account onboarding

Native registration uses Supabase Auth's public signup and resend endpoints with the publishable key. When confirmation is required, show Check your email and require confirmation before sign-in. The configured redirect is `<platform>/auth/email-confirmed`; add the final HTTPS URL to the project's allowed redirects and configure signup mail delivery. This page offers a `chatbotmail://auth/email-confirmed` return link. The native app treats that link as navigation only, and obtains its session by signing in rather than trusting URL-supplied credentials.

After authentication, call `POST /api/v1/client/onboarding` with the user's bearer token and no body. The trusted server derives the user from the JWT, serializes provisioning per user, and transactionally creates or reuses an owned organization, workspace, active mail assistant, and protected `native_accounts` mapping. Store the returned `chatbotId` for this account. The client does not choose an owner, organization, or assistant ID. Repeating the call reuses the mapping; an invalid owner or inactive mapped assistant returns 409, while a missing setup migration returns 503.

Next, request `/mail/status?chatbotId=<returned ID>`. Connected returning users can open Inbox. Users with no active mailbox should see Connect Gmail and an optional skip into AI writing tools; mailbox-dependent actions still require connection. Save completion per account and clear or replace account-scoped state on sign-out/account switches. Gmail connection uses the native transaction below; platform registration and mailbox consent are separate steps.

Conversation shape:

```json
{
  "id": "108fef9a-3488-4928-abd6-f5dc58c315b5",
  "chatbotId": "cb_abcdefghijklmnop",
  "title": "Opening question",
  "createdAt": "2026-11-17T00:00:00.000Z",
  "updatedAt": "2026-11-17T00:00:01.000Z",
  "revision": "2",
  "lastTurn": {
    "requestId": "4494f31a-4f2c-45e6-9080-aa52df6c7525",
    "status": "completed",
    "text": "A saved reply",
    "citations": [],
    "error": null
  }
}
```

`lastTurn` is null before any send. Status is `running`, `completed`, `failed` or `interrupted`. A model failure is normally an HTTP 200 response with a terminal `failed` turn and a safe `error` string; HTTP success alone does not mean the model answered successfully. The title is derived from the opening message.

Message page:

```json
{
  "conversation": { "...": "conversation object above" },
  "messages": [{
    "id": "70438851-2115-4240-87e4-fc561545374e",
    "role": "assistant",
    "text": "A saved reply",
    "citations": [],
    "sequence": "2",
    "createdAt": "2026-11-17T00:00:01.000Z",
    "requestId": "4494f31a-4f2c-45e6-9080-aa52df6c7525",
    "status": "completed"
  }],
  "nextCursor": "2",
  "hasMore": false
}
```

`conversation` in this illustrative page is the complete conversation object in a real response. Citation fields are `{n,title,sourceUrl,snippet}`; `sourceUrl` can be null. Messages use `text`, not `content`. UUIDs are strings. Message cursors, `sequence` and `revision` are decimal **strings**: preserve them without floating-point conversion. Conversation-list cursors are opaque strings, not message cursors. A message page's nextCursor advances only over the messages actually returned, never over uncommitted or unreturned rows.

## Send and retry rules

1. Create a conversation using a new UUID. If the network result is uncertain, retry with the SAME UUID. The ID is scoped to its actual owner and chatbot; another account cannot take it over.
2. Generate one request UUID for a user send. Keep the UUID and exact trimmed message until its outcome is known. Max message length is 4,000 characters.
3. Submit the message. A completed/failed/interrupted request ID replays its stored result without calling the model or mailbox tools again. Reusing it for different content returns 409. A new deliberate attempt requires a new request ID.
4. On a lost connection, recover with GET metadata/messages first. Do not silently generate a new request ID and resend.
5. HTTP 409 means either another reply is running or the request ID conflicts. Refresh, wait and inspect the error message. Only one generation may run per conversation across all devices.
6. HTTP 401 requires sign-in/token refresh, not a new conversation. A 404 means unknown/not owned/deleted; remove that conversation from the local UI. Respect 429 and Retry-After.

The synchronous JSON send can take up to four minutes. A stream or connection is not a durable background job: cancellation may stop generation. A crashed process leaves a ten-minute lease; subsequent reads report an expired lease as interrupted, and maintenance/new sends clean it up. Interrupted requests are never automatically regenerated because a model or mailbox tool may already have executed.

Optional `stream:true` uses POST/fetch SSE. Events are `accepted`, `sources`, `token`, `tool`, `done` and `error`. Each JSON data payload includes `type`; `done` is `{type:"done",turn:<terminal turn>}` and is emitted only after persistence commits. EOF without `done` is an interruption. Other devices see committed messages and turn state, not every token in a partially generated reply.

`emailManager:true` is an explicit optional capability, restricted to a chatbot's organization owners/admins and their own connected mailbox. The existing approval gate is preserved. General native chat should omit it. Do not automatically retry a mailbox operation as a new request after an uncertain result.

## Synchronization loop

On conversation open, fetch messages with `after=0`, merge by message ID, follow nextCursor until hasMore is false, and retain that cursor for this account/conversation. While visible, poll about every five seconds; refresh immediately after foregrounding or reconnecting. Use lastTurn status as well as messages because a failed turn may produce no assistant text. List conversations again to discover other-device additions/deletions. If a selected conversation returns 404, clear it locally.

The server is authoritative. Optimistic bubbles and local caches must be reconciled with committed messages. Logout and account switching must clear in-memory state and any account-scoped transcript cache. This release does not implement an offline send outbox or automatic background generation recovery.

## Web and Android handoff

The web interface is `/chat/<public-chatbot-id>` and the Assistant page now uses the same private API. `packages/client-sdk` provides a headless TypeScript client, including SSE handling and expected-account checks.

For Quen's existing Kotlin project:

- Replace widget config/session/message calls with the routes above. The old widget endpoints deliberately require a web Origin; do not invent an Origin header as native authentication.
- Add sign-in against the same Supabase project, refreshing its user session. Store refresh credentials with Android Keystore-backed protection. Keep public platform/chatbot/Supabase configuration separate from credentials.
- Replace the five-minute local widget-token expiry logic with Supabase token expiry/refresh. Persist the conversation UUID separately from credentials. Read history from the server instead of treating the last 40 SharedPreferences messages as authoritative.
- Use the JSON send first with stable request IDs; add optional SSE token rendering afterwards. Both transports use the same conversation and message contract.
- Clear account data on logout, and refresh on the app foreground/network reconnect. Test with the SAME account and chatbot at the web `/chat/…` URL.

Existing anonymous widget sessions, organization playground history and the tab-only mail fallback are not automatically merged into private conversations. Analytics visitor hashes are not identity proofs. Anonymous-to-account claiming needs an explicit, separately secured flow before historical sessions can be imported.

## Checks

`packages/core/test/client-conversations.test.ts` uses an empty disposable PostgreSQL database named `*_client_sync_test`. It installs the relevant original tables and the new migration without requiring pgvector, then tests owner/RLS isolation, deduplication, concurrent sends, lease recovery, ordered pagination and deletion. It refuses a non-empty database. Never point it at production.

Production and real-provider validation remain separate from these local tests. The machine-readable contract is served by `/api/v1/openapi.json` under the Client tag.

## Native mail API

Added November 18, 2026. Lets native apps (Android first) manage the signed-in user's own Gmail connection and approval requests with the same bearer token as the rest of this API. The web Assistant page, its server actions and its cookie-based Gmail connect flow are unchanged.

**Release prerequisites.** Apply `packages/database/migrations/20261118090000_native_mail.sql` (adds `mail_oauth_transactions` and the `uncertain` action status) through the existing migration runner after `20261112090000_mail_agent.sql`. It is applied in this project's configured shared database; see the release prerequisite above for the additional onboarding and draft migrations. The Google OAuth client needs **no new redirect URI**: native connections use the existing `<platform>/api/agent/gmail/callback`. Optionally set `MAIL_NATIVE_RETURN_URI` (default `chatbotmail://oauth/gmail`; a custom scheme or an https App Link, without a query string).

**Errors.** Every `/api/v1/client/*` error may now include an additive `reason`: `{"error":{"code","message","reason?"}}`. Existing `code`, `message` and status codes are unchanged. Conversation sends: `request_mismatch`, `request_running`, `conversation_busy`, `lease_lost` (all 409), `mailbox_not_connected` (409), `mail_role_required` (403).

All mail routes are under `/api/v1/client/mail`, use `Authorization: Bearer <Supabase access JWT>`, omit Origin, and return `Cache-Control: private, no-store`.

| Method | Path | Body/query | Result |
|---|---|---|---|
| GET | `/status` | `chatbotId` | Status object |
| POST | `/connect` | `{chatbotId, verifierChallenge}` | `{transactionId, authorizationUrl, expiresAt}` |
| POST | `/connect/complete` | `{transactionId, code, verifier}` | Status object |
| DELETE | `/connection` | — | 204 |
| GET | `/actions` | `filter=pending` (default) or `recent` (7 days) | `{actions: ActionItem[]}` (≤ 50) |
| GET | `/actions/{id}` | — | Action detail |
| POST | `/actions/{id}/approve` | `{version}` | `{action: ActionItem}` |
| POST | `/actions/{id}/reject` | — | `{action: ActionItem}` |

Status object:

```json
{ "provider": "gmail", "serverReady": true, "eligible": true, "role": "owner",
  "connection": { "email": "me@example.com", "status": "active" }, "pendingApprovals": 2 }
```

`role` is `owner`, `admin`, `member` or null (not a member of the chatbot's organization). `eligible` is owner/admin. `serverReady` means Google OAuth, `MAIL_TOKEN_SECRET` and the agent model are configured. `connection` is null when no mailbox is connected; `revoked` means Gmail must be connected again.

### Connecting Gmail from a native app

1. The app creates a random `verifier` (43–128 base64url characters) and keeps it locally. It sends `verifierChallenge = base64url(SHA-256(verifier))` (43 characters) with `POST /connect`. Only owners/admins (403 `mail_role_required`) on a configured server (503 `mail_not_configured`) can start. The server stores only `SHA-256(state)`, the challenge and a server-side PKCE verifier; the transaction expires after 10 minutes.
2. The app opens `authorizationUrl` in the system browser or a Custom Tab (never a WebView). It contains the state and an S256 PKCE challenge.
3. Google returns to the existing callback. When the browser has no matching state cookie, the state is looked up as a native transaction and consumed once. The code is exchanged with PKCE, the refresh token is encrypted and parked on the transaction, and the browser is sent to `MAIL_NATIVE_RETURN_URI?tx=<transactionId>&code=<one-time completion code>`, or `?tx=<id>&error=denied|permission|failed|expired`. No Google token is ever placed in a URL.
4. The app checks that `tx` is the transaction it started and calls `POST /connect/complete` with the code and its verifier. The connection is saved only for the transaction's own user with a matching completion code and verifier. Errors: 404 `transaction_not_found` (unknown or another user's), 410 `transaction_expired`, 409 `already_completed`, 409 `callback_pending`, 400 `verification_failed`, 400 `oauth_denied|oauth_permission|oauth_failed`.
5. Treat the deep link only as a signal: always re-read `/status`.

Someone who starts a transaction and sends its URL to a victim never receives the completion code (it goes to the victim's device), and the victim's device does not have the verifier, so the victim's mailbox cannot be bound to another account. A malicious app on the same device that registers the same custom scheme could receive the code, but it would still need the verifier; use a verified https App Link for `MAIL_NATIVE_RETURN_URI` to remove even that case.

### Approval requests

ActionItem:

```json
{ "id": "uuid", "kind": "send", "summary": "Send \"Hi\" to ana@example.com", "status": "pending",
  "error": null, "createdAt": "ISO", "resolvedAt": null, "to": "ana@example.com", "subject": "Hi", "messageCount": null }
```

Status: `pending`, `processing`, `done`, `rejected`, `failed`, or `uncertain` (Gmail did not confirm; it may or may not have happened, and it is never retried automatically). `to`/`subject` are set for `send`, `messageCount` for `trash`.

Detail (`GET /actions/{id}`) reads Gmail live:

```json
{ "action": { "…": "ActionItem" }, "account": "me@example.com", "version": "<64 hex chars or null>",
  "send": { "draftId": "…", "to": ["…"], "cc": [], "bcc": [], "subject": "…", "body": "complete plain text",
            "attachments": [{ "filename": "a.pdf", "mimeType": "application/pdf", "size": 1234 }], "draftExists": true },
  "trash": null }
```

For `trash`: `"send": null, "trash": { "messages": [{ "id", "from", "subject", "date", "snippet" }], "missing": ["id"] }`. When a send's draft no longer exists, `draftExists` is false, the stored preview is shown and `version` is null. For an `uncertain` send, `draftExists: false` means Gmail most likely sent it (a sent draft disappears from Drafts).

Approve with the `version` the user reviewed. The server recomputes it from Gmail (send: draft message ID, To/Cc/Bcc, subject, body, attachments; trash: the sorted message IDs) and refuses any change with 409 `stale_approval` before anything runs; a missing draft is 409 `draft_missing`. It then uses the same atomic `pending → processing` claim as the web page, so double taps, retries and other devices get 409 `already_handled`. The response is 200 with the final ActionItem: `done`, `failed` (Gmail refused; nothing happened, or for Trash only the stated part) or `uncertain`. Reject moves only `pending` to `rejected` (a draft stays in Gmail Drafts); otherwise 409 `already_handled`. Unknown or another user's request: 404 `action_not_found`. Mailbox problems: 404 `mailbox_not_connected`, 403 `mailbox_revoked`, 409 `mail_not_configured`.

There is a short window between the version check and Gmail's send in which an edit made in Gmail itself could still be sent; Gmail offers no conditional send. Exactly-once delivery is not claimed: a network failure during a send is reported as `uncertain`.

### Labels, attachments, formatted drafts and scheduled send

Added November 25, 2026. **Release prerequisite:** apply `packages/database/migrations/20261125090000_mail_scheduled_send.sql` (adds `scheduled_for`, `approved_version` and the `scheduled` status) **before** deploying this code: the action queries read the new columns. No new Google scope is needed (`gmail.modify` covers labels and attachments).

| Method | Path | Body/query | Result |
|---|---|---|---|
| GET | `/messages` | adds optional `labelId` (`Label_…`) | Messages now include `labelIds` (user labels only) |
| GET | `/messages/{id}` | — | Adds `labelIds` and `attachments: [{partId, filename, mimeType, size}]` |
| GET | `/messages/{id}/attachments/{partId}` | `chatbotId` | The file (≤ 15 MB), always `Content-Disposition: attachment`, `nosniff`, sandbox CSP |
| GET | `/messages/{id}/attachments/{partId}/text` | `chatbotId` | `{filename, text, truncated}` for text, Markdown, CSV, HTML and DOCX (read on the server) and PDF and images (read by Gemini when `GOOGLE_GENERATIVE_AI_API_KEY` is set; ≤ 14 MB) (≤ 20,000 chars); 415 `attachment_unsupported`, 422 `attachment_unreadable` |
| GET | `/labels` | `chatbotId` | `{labels: [{id, name, color}]}`, user labels only |
| POST | `/labels` | `{name}` | 201 label; 409 `label_exists` |
| POST | `/labels/apply` | `{ids, add, remove}` | `{ok: true}`. Only `Label_…` ids: system labels (INBOX, TRASH, SPAM…) are refused, so labels can never bypass Trash approval |
| POST | `/drafts` | adds `format: "plain"\|"markdown"` and `attachments: [{filename, mimeType, data(base64)}]` | ≤ 10 files, ≤ 10 MB in total; 400 `attachment_invalid` |
| POST | `/actions/{id}/approve` | adds optional `sendAt` (ISO 8601 with offset) | `scheduled` ActionItem with `scheduledFor` |
| POST | `/actions/{id}/unschedule` | — | Back to `pending`; 409 `already_handled` once it is no longer scheduled |

**Formatted drafts.** `markdown` renders a small subset (paragraphs, `#` headings, `-`/`1.` lists, `**bold**`, `*italic*`, `` `code` ``, `[text](https://…)` with http, https and mailto only) to HTML after escaping all input, so the body can never add its own tags or attributes. The message is `multipart/alternative` with a plain-text copy (markers removed, link targets in brackets); review and approval show that plain copy, and `version` covers it. Drafts with files go through Gmail's media upload endpoint.

**Scheduled send.** Only a `pending` send can be scheduled, between one minute and 60 days ahead. The approval stores the reviewed `version`. The maintenance cron (every 10 minutes) claims due rows atomically (`scheduled → processing`, `skip locked`), re-reads the draft and sends it only if its version still matches; an edited or deleted draft ends `failed` with the reason, and an unconfirmed send ends `uncertain`. `/actions?filter=pending` now also lists `scheduled` requests; `pendingApprovals` counts only `pending`. Reject also declines a `scheduled` send. The AI agent cannot schedule: only the owner's approval can.

**Agent tools.** The mail agent adds `list_labels`, `label_mail` (by name; unknown names are reported, never created implicitly), `create_label`, `read_attachment` (document text, ≤ 8,000 characters) and `formatted` on `draft_email`.

### Native push

Not implemented. Existing new-mail notifications use browser Web Push (VAPID); there is no FCM sender or device-token storage. Native apps should refresh `/status` and `/actions` in the foreground.

### Checks

`apps/dashboard/test/native-mail.test.ts` (route logic with mocked storage and Gmail), `packages/mail-agent/test/native.test.ts` (draft parsing, typed Gmail errors, PKCE) and `packages/mail-agent/test/native.db.test.ts`, which needs `NATIVE_MAIL_TEST_DATABASE_URL` pointing to an empty disposable `*_native_mail_test` database and refuses anything else.
