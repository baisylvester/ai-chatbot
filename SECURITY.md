# Security model and review

## Model

- **Tenancy:** organizations → workspaces → websites → chatbots. Every tenant table has `organization_id`.
  - Dashboard requests run as the restricted `chatbot_app` role with row-level security (members read, owners and admins write).
  - "Trusted" server paths (widget API, ingestion, maintenance) use the owner role and filter by organization explicitly. Parent IDs are always re-read from the database, never taken from the client.
- **Admin operations that need both an authorization check and a trusted write** (API key creation, conversation deletion) run in two separate transactions. The trusted step only accepts a grant object returned by the check. This also prevents nested database connections from exhausting the pool.
- **Widget:**
  - The public chatbot ID is not a secret.
  - Each request must come from an allowed domain, re-checked on every request, and the chatbot must be active.
  - Sessions use HMAC-signed tokens that expire after 2 hours.
  - No cookies are used.
  - Responses never include provider, model or internal error details.
- **Server API:** private keys (`cbk_…`) are stored only as SHA-256 hashes, can be revoked, and are scoped to one organization. The API sends no CORS headers.
- **Dashboard:**
  - Pages are protected by `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, HSTS, `nosniff`, a strict referrer policy and a restrictive `Permissions-Policy`.
  - Server actions rely on Next.js same-origin checks. The cookie-authenticated playground route also requires a same-origin JSON request.
  - The iframe page restricts framing to the chatbot's allowed domains.
- **Rendering:** the widget inserts text only with `textContent`, and links must be http(s). React escapes all dashboard output.
- **Knowledge:**
  - URL import only reaches public addresses, re-checked on every redirect, with size and time limits.
  - Uploads are checked for type, size, PDF page count and DOCX decompressed size.
  - Retrieved content is passed to the model as untrusted reference material.
- **Limits:**
  - **Rate limits:** shared in Postgres for widget sessions and messages, the API, the playground and voice.
  - **Body size:** capped before parsing.
  - **Database:** connection-wait and statement timeouts.
  - **Realtime voice:** one call per conversation, and a daily budget per organization.

## Review (Phase 8)

An independent reviewer read the whole codebase in November 2026 (code reading only, nothing run). It found **no cross-tenant read or write path**. The isolation, row-level security, tokens, SQL, SSRF and XSS checks all held up. Findings and outcomes:

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium-high | Two server actions held a user and a trusted DB connection at once. With a pool of 5 and no wait timeout, a signed-in user could freeze an instance | **Fixed:** two-step grant pattern, pool `connectionTimeoutMillis` 10s, `statement_timeout` 30s, pool size configurable |
| 2 | Medium | Realtime voice: OpenAI's session events reveal the system prompt to the visitor, and the client secret allows session changes | **Mitigated:** settings warn not to put secrets in prompts for realtime chatbots, one live call per conversation, daily per-org minutes budget. *Open:* a server-side (sideband) realtime connection would remove the exposure |
| 3 | Medium | Realtime minutes went unbilled when the browser never reported the call end | **Fixed:** maintenance closes abandoned calls and records usage (capped at 60 min) |
| 4 | Low-medium | Realtime transcripts come from the browser but were stored like model output | **Fixed:** stored as `voice-transcript` and labelled "reported by the visitor's browser, unverified" |
| 5 | Low-medium | A DOCX zip bomb or a huge PDF could exhaust memory | **Fixed:** the ZIP central directory is checked before inflating (100 MB total, 200:1 ratio, 2,000 entries, no ZIP64), and PDFs are capped at 1,000 pages |
| 6 | Low | `returnTo` redirect accepted `/\evil.com` (not exploitable in practice) | **Fixed:** only `/orgs/<id>…` or `/chatbots/<id>` paths |
| 7 | Low | The playground route had no Origin check | **Fixed:** requires same-origin and `application/json` |
| 8 | Low | Request bodies were read before size checks | **Fixed:** capped readers and Content-Length checks before parsing |

Known limitations:
- **Rate limits:** origin checks don't stop non-browser clients; rate limits do.
- **SSRF:** URL import has a narrow DNS-rebinding window, because the resolved address isn't pinned.
- **Member management:** admins can edit `organization_members` rows, including owners'. No dashboard screen does this yet. Add an owner guard before building member management.
- **Ingestion:** runs in the web process. Move it to an isolated worker with memory limits for untrusted large files at scale.

Report security issues privately to the maintainers rather than in a public issue.
