# Native mailbox and writing API

These additions support the native Inbox, reader, composer, AI mail, and prompt library. They use the existing `/api/v1/client` Supabase bearer authentication, per-user rate limits, private/no-store responses, and `X-Authenticated-User` response check. Provider refresh tokens and AI credentials stay on the server.

Mailbox requests require `?chatbotId=cb_...`, an owner/admin role in that chatbot's organization, and the authenticated user's connected Gmail account. An organization API key is not a user token.

| Method and path | Input | Result |
|---|---|---|
| GET `/mail/messages` | `folder`, optional `query`, optional opaque `cursor` | `{messages, nextCursor}`; 20-message pages |
| GET `/mail/messages/{messageId}` | Valid Gmail message ID | Plain-text message, sender, recipients, subject, date, `truncated` |
| POST `/mail/modify` | `{ids, action, requestId}` | `{actionId, waitingForApproval}` |
| POST `/mail/drafts` | `{requestId, to, subject, body, replyToMessageId?}` | `{draftId, actionId, to, subject}` |
| POST `/mail/writing` | `{operation, text, tone?, length?, language?}` | `{text}` |

Folders: `inbox`, `unread`, `starred`, `attachments`, `sent`, `drafts`, `archive`, `spam`, `trash`, `all`. Search expressions are grouped inside the selected folder. Cursors are provider tokens, not offsets.

Mailbox actions: `archive`, `move_to_inbox`, `mark_read`, `mark_unread`, `star`, `unstar`, `mark_spam`, `trash`. Reversible label changes run immediately. `trash` only queues a request; use the existing action detail and version-bound approval endpoints to execute it.

Draft creation only creates a Gmail draft and a pending Send review. It never sends. The server claims a UUID before calling Gmail; completed requests replay their stored receipt. Changed content under the same UUID returns `request_mismatch`. In-progress/uncertain requests return `draft_uncertain`; inspect Gmail Drafts before starting another request. A provider timeout is never automatically retried. The native composer restores an interrupted submission as uncertain after process death.

Writing operations: `write`, `reply`, `summary`, `grammar`, `translate`; text limit 20,000 characters. Tones: Professional, Formal, Casual, Friendly, Confident, Empathetic. Lengths: Short, Medium, Long. Writing requires platform sign-in, and can work without connecting a mailbox. It has no mailbox tools and does not claim to send or modify mail. Generated text remains editable and requires review.

## Rollout

Before deploying these routes, apply the existing client-conversation and native-mail migrations, then `20261119090000_mail_client_drafts.sql`. The latter creates a server-only, RLS-enabled request table; it contains fingerprints and receipts, not message bodies or provider secrets.

The three native conversation/mail migrations were applied to the configured shared database on 19 November 2026 with user approval. Native API production deployment remains pending. The release server must expose the client routes before a native app pointed at it can use them. Do not test unknown-outcome handling by retrying real sends or moving real messages to Trash.

## Coverage limits

The implementation currently supports one Gmail mailbox per platform user. Microsoft/Outlook, Yahoo, iCloud/IMAP, unified accounts, custom-label management, mail pinning, attachment upload/download, rich HTML composing, and native new-mail push are not implemented. An attachment filter finds messages with attachments; it does not download their files. Approval details can display attachment metadata for drafts created elsewhere.

Explicit email-manager conversation turns use the configured MAIL_AGENT_PROVIDER and MAIL_AGENT_MODEL, independently of the public chatbot model. Ordinary turns continue to use the chatbot settings. Mail ownership/admin checks and active-connection checks run before selecting those mailbox tools. Tool completion logs include only tool names and queued-action counts, never email contents or addresses.