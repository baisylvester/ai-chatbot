const uuid = { type: "string", format: "uuid" } as const;
const cursor = { type: "string", pattern: "^[0-9]+$", description: "Opaque decimal cursor. Preserve as a string; do not convert to floating point." } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const security = [{ userToken: [] }];
const failures = Object.fromEntries([400, 401, 403, 404, 409, 429, 500, 502].map(status => [String(status), { description: "Client error; inspect error.code and error.message", content: json(ref("Error")) }]));
const id = { name: "conversationId", in: "path", required: true, schema: uuid };
const body = (schema: unknown) => ({ required: true, content: json(schema) });
const status = { type: "string", enum: ["running", "completed", "failed", "interrupted"] };
export const clientSchemas = {
  NativeAccount: { type: "object", required: ["chatbotId"], additionalProperties: false, properties: {
    chatbotId: { type: "string", description: "The authenticated user's active personal assistant ID, assigned by the server." },
  } },
  ClientTurn: { type: "object", required: ["requestId", "status", "text", "citations", "error"], properties: {
    requestId: uuid, status, text: { type: "string" }, citations: { type: "array", items: ref("Citation") }, error: { type: ["string", "null"] },
  } },
  ClientConversation: { type: "object", required: ["id", "chatbotId", "title", "createdAt", "updatedAt", "revision", "lastTurn"], properties: {
    id: uuid, chatbotId: { type: "string" }, title: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, revision: cursor,
    lastTurn: { anyOf: [ref("ClientTurn"), { type: "null" }] },
  } },
  ClientMessage: { type: "object", required: ["id", "role", "text", "citations", "sequence", "createdAt", "requestId", "status"], properties: {
    id: uuid, role: { type: "string", enum: ["user", "assistant"] }, text: { type: "string" }, citations: { type: "array", items: ref("Citation") }, sequence: cursor,
    createdAt: { type: "string", format: "date-time" }, requestId: { anyOf: [uuid, { type: "null" }] }, status,
  } },
  MailStatus: { type: "object", required: ["provider", "serverReady", "eligible", "role", "connection", "pendingApprovals"], properties: {
    provider: { type: "string", enum: ["gmail"] }, serverReady: { type: "boolean" }, eligible: { type: "boolean", description: "Owner or admin of the chatbot organization" },
    role: { type: ["string", "null"], enum: ["owner", "admin", "member", null] }, pendingApprovals: { type: "integer" },
    connection: { anyOf: [{ type: "object", required: ["email", "status"], properties: { email: { type: "string" }, status: { type: "string", enum: ["active", "revoked"] } } }, { type: "null" }] },
  } },
  MailAction: { type: "object", required: ["id", "kind", "summary", "status", "error", "createdAt", "resolvedAt", "to", "subject", "messageCount"], properties: {
    id: uuid, kind: { type: "string", enum: ["send", "trash"] }, summary: { type: "string" }, status: { type: "string", enum: ["pending", "processing", "done", "rejected", "failed", "uncertain"] },
    error: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" }, resolvedAt: { type: ["string", "null"], format: "date-time" },
    to: { type: ["string", "null"] }, subject: { type: ["string", "null"] }, messageCount: { type: ["integer", "null"] },
  } },
  ClientMessagePage: { type: "object", required: ["conversation", "messages", "nextCursor", "hasMore"], properties: {
    conversation: ref("ClientConversation"), messages: { type: "array", items: ref("ClientMessage") }, nextCursor: cursor, hasMore: { type: "boolean" },
  } },
};
export const clientPaths = {
  "/api/v1/client/onboarding": { post: {
    tags: ["Client"], security, summary: "Provision or reuse the signed-in user's private mail assistant",
    description: "No request body is needed. Owner, organization and chatbot identifiers are derived on the server. Provisioning is transactional and idempotent for this account. Personal assistants remain accessible only to their owner through the native client API.",
    responses: { "200": { description: "The current account's personal assistant", content: json(ref("NativeAccount")) }, "503": { description: "Account setup is temporarily unavailable", content: json(ref("Error")) }, ...failures },
  } },
  "/api/v1/client/chatbots/{chatbotId}": { get: {
    tags: ["Client"], security, summary: "Get chatbot configuration with a user token (native and web)",
    parameters: [{ name: "chatbotId", in: "path", required: true, schema: { type: "string" } }],
    responses: { "200": { description: "Active chatbot's public configuration", content: json(ref("PublicConfig")) }, ...failures },
  } },
  "/api/v1/client/conversations": {
    get: { tags: ["Client"], security, summary: "List only the signed-in user's conversations", parameters: [
      { name: "chatbotId", in: "query", required: true, schema: { type: "string" } }, { name: "before", in: "query", schema: { type: "string" }, description: "Previous page's nextCursor" },
    ], responses: { "200": { description: "Up to 50 conversations, newest creation first", content: json({ type: "object", required: ["conversations", "nextCursor"], properties: { conversations: { type: "array", items: ref("ClientConversation") }, nextCursor: { type: ["string", "null"] } } }) }, ...failures } },
    post: { tags: ["Client"], security, summary: "Create a durable private conversation idempotently", requestBody: body({ type: "object", additionalProperties: false, required: ["id", "chatbotId"], properties: { id: uuid, chatbotId: { type: "string" } } }),
      responses: { "200": { description: "New or existing conversation belonging to this user and chatbot", content: json(ref("ClientConversation")) }, ...failures } },
  },
  "/api/v1/client/conversations/{conversationId}": {
    get: { tags: ["Client"], security, summary: "Read owned conversation metadata and last turn status", parameters: [id], responses: { "200": { description: "Owned conversation", content: json(ref("ClientConversation")) }, ...failures } },
    delete: { tags: ["Client"], security, summary: "Delete the owned conversation across devices", parameters: [id], responses: { "204": { description: "Deleted; subsequent reads return 404" }, ...failures } },
  },
  "/api/v1/client/conversations/{conversationId}/messages": {
    get: { tags: ["Client"], security, summary: "Recover committed messages after a cursor", parameters: [id, { name: "after", in: "query", schema: { ...cursor, default: "0" } }],
      responses: { "200": { description: "Up to 100 messages, in committed sequence order", content: json(ref("ClientMessagePage")) }, ...failures } },
    post: { tags: ["Client"], security, summary: "Send one deduplicated turn; terminal responses are durable", parameters: [id],
      description: "Retain requestId on uncertain retries. Completed requests replay without model/tool execution. Concurrent sends return 409. stream=true emits accepted, sources, token, tool, done; done contains {type:'done',turn:ClientTurn}. Disconnection requires recovery through GET, not an automatic new request ID. Model failures return a terminal failed turn.",
      requestBody: body({ type: "object", additionalProperties: false, required: ["requestId", "message"], properties: { requestId: uuid, message: { type: "string", minLength: 1, maxLength: 4000 }, stream: { type: "boolean", default: false }, emailManager: { type: "boolean", default: false, description: "Explicit, managed-chatbot owner/admin capability for the signed-in user's connected mailbox" } } }),
      responses: { "200": { description: "Persisted turn or SSE stream", content: { ...json({ type: "object", required: ["turn"], properties: { turn: ref("ClientTurn") } }), "text/event-stream": { schema: { type: "string" } } } }, ...failures },
    },
  },
  "/api/v1/client/mail/status": { get: { tags: ["Client"], security, summary: "Mailbox connection, eligibility and pending approvals",
    parameters: [{ name: "chatbotId", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Status", content: json(ref("MailStatus")) }, ...failures } } },
  "/api/v1/client/mail/connect": { post: { tags: ["Client"], security, summary: "Start a single-use native Gmail connection (owners/admins)",
    description: "Open authorizationUrl in the system browser. Google returns to the existing callback, which redirects to MAIL_NATIVE_RETURN_URI with tx and a one-time completion code. Errors carry error.reason (mail_role_required, mail_not_configured).",
    requestBody: body({ type: "object", additionalProperties: false, required: ["chatbotId", "verifierChallenge"], properties: { chatbotId: { type: "string" }, verifierChallenge: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$", description: "base64url(SHA-256(verifier))" } } }),
    responses: { "200": { description: "Transaction", content: json({ type: "object", required: ["transactionId", "authorizationUrl", "expiresAt"], properties: { transactionId: uuid, authorizationUrl: { type: "string", format: "uri" }, expiresAt: { type: "string", format: "date-time" } } }) }, "503": { description: "Gmail is not configured", content: json(ref("Error")) }, ...failures } } },
  "/api/v1/client/mail/connect/complete": { post: { tags: ["Client"], security, summary: "Complete a native Gmail connection with the completion code and verifier",
    requestBody: body({ type: "object", additionalProperties: false, required: ["transactionId", "code", "verifier"], properties: { transactionId: uuid, code: { type: "string" }, verifier: { type: "string" } } }),
    responses: { "200": { description: "Status after connecting", content: json(ref("MailStatus")) }, "410": { description: "Transaction expired", content: json(ref("Error")) }, ...failures } } },
  "/api/v1/client/mail/connection": { delete: { tags: ["Client"], security, summary: "Revoke and remove the caller's mailbox and its queued requests", responses: { "204": { description: "Disconnected" }, ...failures } } },
  "/api/v1/client/mail/actions": { get: { tags: ["Client"], security, summary: "List the caller's send and trash requests",
    parameters: [{ name: "filter", in: "query", schema: { type: "string", enum: ["pending", "recent"], default: "pending" } }],
    responses: { "200": { description: "Up to 50 requests", content: json({ type: "object", required: ["actions"], properties: { actions: { type: "array", items: ref("MailAction") } } }) }, ...failures } } },
  "/api/v1/client/mail/actions/{actionId}": { get: { tags: ["Client"], security, summary: "Request with live Gmail content and the version to approve", parameters: [{ name: "actionId", in: "path", required: true, schema: uuid }],
    responses: { "200": { description: "action, account, version (null when a draft is missing), send or trash details", content: json({ type: "object", required: ["action", "account", "version", "send", "trash"], properties: { action: ref("MailAction"), account: { type: "string" }, version: { type: ["string", "null"] }, send: { type: ["object", "null"] }, trash: { type: ["object", "null"] } } }) }, ...failures } } },
  "/api/v1/client/mail/actions/{actionId}/approve": { post: { tags: ["Client"], security, summary: "Send or trash exactly the reviewed version",
    description: "409 reasons: stale_approval, draft_missing, already_handled. 200 returns the final status: done, failed or uncertain (never retried automatically).",
    parameters: [{ name: "actionId", in: "path", required: true, schema: uuid }], requestBody: body({ type: "object", additionalProperties: false, required: ["version"], properties: { version: { type: "string", pattern: "^[0-9a-f]{64}$" } } }),
    responses: { "200": { description: "Final request state", content: json({ type: "object", required: ["action"], properties: { action: ref("MailAction") } }) }, ...failures } } },
  "/api/v1/client/mail/actions/{actionId}/reject": { post: { tags: ["Client"], security, summary: "Decline a pending request (a draft stays in Gmail Drafts)", parameters: [{ name: "actionId", in: "path", required: true, schema: uuid }],
    responses: { "200": { description: "Rejected request", content: json({ type: "object", required: ["action"], properties: { action: ref("MailAction") } }) }, ...failures } } },
};
