# Deploying the Chatbot Platform

## Unified assistant follow-up (November 20, 2026)

**25 November 2026:** migration `20261125090000_mail_scheduled_send.sql` was applied to the shared database, then Pages deployment 882bc098 went live with mail labels, attachment download/reading, formatted and attachment drafts, and scheduled send (sent by the maintenance cron). The Worker bundle is 25.1 MB of Cloudflare's 25 MiB (26.2 MB) limit: server code must import `@chatbot/rag-engine/runtime`, not the package index, unless it parses files, or the PDF/Word parsers are copied into many route chunks. Mail attachments are read without those parsers (text/HTML directly, DOCX by unzipping, PDF and images through Gemini with `GOOGLE_GENERATIVE_AI_API_KEY`).

Pages deployment 3fd418c5-e256-42a5-b93a-85ceb72d9cae and Worker version 1dfec09c-46eb-410c-a973-6176ddb786d4 are live. The private personal-assistant route now uses the deployed assistant provider for general chat without granting Gmail tools. Public chatbot model selection, ownership checks, secrets, bindings and maintenance cron are preserved. Preview and final live physical-device checks passed, including general chat without mailbox capability and a same-conversation Gmail search/context follow-up. This update supersedes the deployment IDs in the earlier onboarding rollout below; no additional database migration was needed.

## Native onboarding rollout (November 19–20, 2026)

The Android app registers users through Supabase Auth, provisions a private assistant through POST /api/v1/client/onboarding, and offers Gmail connection or an initial skip. The updated /api/v1/client/* handlers and /auth/email-confirmed are live at https://ai-chatbot-9wg.pages.dev as of November 20. See docs/CLIENT_API.md and the Android project's docs/NEW_USER_ONBOARDING.md for the contract and test limits.

The four client migrations (20261117090000_client_conversations.sql, 20261118090000_native_mail.sql, 20261119075549_native_onboarding.sql, 20261119090000_mail_client_drafts.sql) were applied to this project's shared database on November 19. Other environments require their own migrations.

After preview checks passed, Pages deployment 016aa41f-e4a0-41e2-83de-3ec1228096dc was promoted live, and maintenance Worker version 0e5d920d-5fb2-4731-8aff-24a5cfbd7d83 received 100% traffic. Existing Worker bindings, secrets and the */10 * * * * schedule were preserved. Temporary Worker preview settings were restored. Rollback references: Pages 55204d58-8162-4918-86ad-f0a1c2d5ef9d and Worker be8b44b7-8a09-4944-945d-54a50bc073a1.

Validation on November 20: production webpack build, TypeScript check, OpenNext packaging, Wrangler dry run, five local runtime checks, and six route checks each against Worker preview, live Pages and live Worker. The local runtime checks used placeholder secrets. Authenticated physical-device tests additionally verified private-assistant setup, active Gmail, real Inbox reading and synthetic AI writing. The final APK passed against direct live HTTPS with no ADB reverse or PC proxy. No email was sent or modified by these checks.

Before opening registration publicly, verify Supabase's exact confirmation redirect allowlist includes https://ai-chatbot-9wg.pages.dev/auth/email-confirmed, retain existing /auth/callback entries, and test confirmation-email delivery using an unused address. Keep email confirmation enabled. Exact allowlist and SMTP settings were not accessible through the available management tools/credentials. The supplied test email already had an account, so fresh-account email delivery/verification remains untested. Google consent tester restrictions/verification and Android release signing also remain release checks.

The Windows symlink fallback rebases direct pnpm store junctions into standalone/OpenNext output trees so packaging uses copied and patched dependencies. The delivered Android APK is debug signed; it preserves the existing account while upgrading known PC loopback configuration to the live origin for the same Supabase project/public key.

## November 17 client-sync release prerequisite

Install the updated lockfile and apply `20261117090000_client_conversations.sql` with the existing migration runner **before** deploying the new server. This development change does not apply a production migration or deploy automatically. New private conversations are account-owned; existing anonymous widget and organization playground transcripts retain their previous access model.

The signed-in web route is `/chat/<active-public-chatbot-id>`. Android and Apple clients must use the same platform URL, active public chatbot ID and Supabase Auth project. Keep the existing exact `/auth/callback` allowlist entry: same-browser chat sign-up continuation uses a short-lived first-party cookie, so an additional redirect wildcard is not required. Confirmation on a different browser/device falls back to the dashboard; open the chat link again there.

See `docs/CLIENT_API.md` for Quen's Android integration contract and `apps/apple/README.md` for native Apple setup. The Swift sources and XcodeGen targets require compilation/signing and real-device validation on a Mac. Native voice and an offline send queue are not part of this first text-chat milestone.

The platform is one Next.js app (`apps/dashboard`) and a Supabase project (Postgres + Auth). It serves the dashboard, the public widget API, the REST API and `embed.js`. These steps use **Vercel + Supabase**. Any Node 20.9+ host works the same way: run `next build` and `next start`, and call the maintenance URL from a cron.

## 1. Database and Auth (Supabase)

1. Use a Supabase project in a region close to your users. This repo uses `sylv_project` (`gmuqwpfllgmvhzhehepp`).
   For this project's local Windows setup, run `powershell -NoProfile -File .\tools\set-supabase-password.ps1`.
   Enter the existing **database password**, not your GitHub password. The script verifies a TLS connection
   before saving the transaction/session pooler URLs and public Auth settings in the root and dashboard
   `.env.local` files. It preserves other settings and does not apply migrations.
2. Apply the migrations using the **Session pooler** connection string (port 5432; Supabase dashboard → Connect). The direct `db.<ref>.supabase.co` host is IPv6-only on most plans:
   ```bash
   DATABASE_URL_UNPOOLED="postgresql://postgres.<ref>:<password>@aws-…pooler.supabase.com:5432/postgres" pnpm --filter @chatbot/database migrate
   ```
   The runner skips migrations already recorded in `schema_migrations`; each new migration runs once in order. Run them before deploying code that needs them. They enable `vector`, create the `chatbot_app` role, and (0011) remove the Data API roles' access to the app's tables.
   The hardening migration moves pgvector into Supabase's `extensions` schema and fixes the user-ID helper's search path. Supabase connections must retain `extensions` in their search path (the project's default already does). The runner accepts both the original four-digit names and timestamped names generated by `supabase migration new`.
3. **Auth → URL Configuration:** set **Site URL** to your public URL and add `https://your-domain/auth/callback` (and `http://localhost:3000/auth/callback` for local work) to **Redirect URLs**. Confirmation emails link there.
4. **Auth → Providers → Email:** keep "Confirm email" on. Supabase's built-in mailer is rate-limited and meant for testing; set up custom SMTP (Auth → SMTP Settings) before real users sign up.
5. Optional: the app never uses the Data API, so you can turn it off (Project Settings → Data API).

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **Transaction pooler** connection string (port 6543) |
| `DATABASE_URL_UNPOOLED` | for migrations | **Session pooler** connection string (port 5432) |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Publishable key (`sb_publishable_…`, Project Settings → API Keys). Safe in the browser: migration 0011 keeps it away from app data |
| `DATABASE_CA_CERT` | optional | PEM text of a custom CA. Supabase hosts already use the bundled Supabase root CA (valid to 2031) |
| `EMBED_TOKEN_SECRET` | yes | 32+ random characters. Rotating it ends every open widget session |
| `CRON_SECRET` | yes | 32+ random characters. Vercel Cron sends it to the maintenance endpoint |
| `NEXT_PUBLIC_PLATFORM_URL` | yes | Public `https://` URL. It goes into the embed snippets and API docs |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `DEEPSEEK_API_KEY` | at least one | Chat models. Embeddings need OpenAI, Gemini or the Neon AI Gateway |
| `ELEVENLABS_API_KEY` | optional | Voice |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | optional | Defaults to the first configured embedding provider |
| `REALTIME_DAILY_MINUTES` | optional | Realtime voice budget per organization per day (default 120) |
| `DATABASE_POOL_MAX` | optional | Connections per server instance (default 10). Keep instances × pool under the Supabase pooler's client limit for your compute size |

In production the server **refuses to start** if a required secret is missing or too short, or if `NEXT_PUBLIC_PLATFORM_URL` isn't `https`. See `src/instrumentation.ts`. Never set `VOICE_MOCK` or `EMBEDDING_PROVIDER=mock` in production.

## 3. Deploy (Vercel)

- **Root directory:** `apps/dashboard`. Install command: `pnpm install --frozen-lockfile`.
- **Build command:** `pnpm --filter @chatbot/embed-sdk build && pnpm --filter @chatbot/dashboard build`. The first step produces `public/embed.js`.
- `apps/dashboard/vercel.json` schedules `GET /api/internal/maintenance` every 10 minutes. Frequent crons need a paid Vercel plan. On Hobby, change the schedule to daily or call the URL from another scheduler:
  ```bash
  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-domain/api/internal/maintenance
  ```
- Point an uptime monitor at `GET /api/health`. It returns 200 `{"status":"ok"}`, or 503 when the database is unreachable.

## 4. After the first deploy

1. Sign up, create your organization, and run through the dashboard. Then run the Test chat with a real provider key.
2. Add a website with your real domain, set a chatbot to **active**, and install the snippet on a staging page.
3. Check **Analytics → Widget health** for refused loads (wrong domain or inactive chatbot).
4. Set conversation **retention** for each organization if your privacy policy needs one.

## Operations

- **Logs** are JSON lines (`level`, `event`, …) from `src/lib/log.ts`. They never contain message text or secrets.
- **Maintenance** (`packages/core/src/maintenance.ts`) does the following on each run:
  - requeues ingestion jobs left stuck by a crash or redeploy, up to 3 attempts;
  - processes queued documents;
  - applies retention;
  - closes and bills abandoned voice calls;
  - prunes rate-limit counters.

  Each run returns counts and is safe to run concurrently.
- **Rate limits** are shared through Postgres (`rate_limit_hit`). If the database is briefly unreachable, each instance falls back to in-memory limits.
- **Backups:** Supabase takes daily backups on paid plans (point-in-time recovery is an add-on). On the free plan, take your own dump (`pg_dump`) before risky migrations.
- **Scaling:** document ingestion runs inside the web process (Next.js `after()`), and maintenance catches anything missed. For heavy uploads, move ingestion to a dedicated worker or queue. Uploads are capped at 10 MB, 1,000 PDF pages and 100 MB of uncompressed DOCX content.

## Tests

```bash
pnpm typecheck
pnpm test                                    # DB integration tests need TEST_DATABASE_URL (a throwaway database, never production)
pnpm --filter @chatbot/embed-sdk build
pnpm --filter @chatbot/e2e install-browsers  # once
pnpm --filter @chatbot/e2e test:e2e          # widget in Chromium, Firefox, WebKit and mobile Chrome
```

`.github/workflows/ci.yml` runs the same checks on every push and pull request.

## Cloudflare Pages (current production: https://ai-chatbot-9wg.pages.dev)

The same OpenNext build runs on Cloudflare Pages (project `ai-chatbot`) and on the Worker `ai-chatbot`, which only exists to run the 10-minute maintenance cron (Pages has no cron triggers).

- **Database:** Workers sockets cannot trust Supabase's private CA, so both connect through the Hyperdrive config `ai-chatbot-db` (binding `HYPERDRIVE`, session pooler, caching disabled, `verify-full` against the uploaded CA `supabase-root-2021`). After a database password change, run `wrangler hyperdrive update` with the new password.
- **Secrets** (`DATABASE_URL`, `EMBED_TOKEN_SECRET`, `CRON_SECRET`) are set on both with `wrangler pages secret put --project-name ai-chatbot` and `wrangler secret put`.
- **Deploy** from `apps/dashboard` (stop the dev server's build conflicts first; works on Windows without Developer Mode):
  ```bash
  pnpm --filter @chatbot/embed-sdk build
  pnpm --filter @chatbot/dashboard build:pages
  pnpm --filter @chatbot/dashboard deploy:pages
  ```
  To update the cron Worker from the same build: `wrangler deploy` with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` set to any placeholder Postgres URL.
- **Supabase Auth:** set the Site URL to the Pages URL and allow `https://ai-chatbot-9wg.pages.dev/auth/callback`.

## Mail agent (`/agent`)

A signed-in user connects their Gmail and asks the assistant to summarize, search, sort and draft (Gemini Flash by default). Sending and moving to Trash only happen when the user presses the approve button. The page works on phones and desktops and can be installed as an app (browser menu → Install / Add to Home screen), which is also how notifications reach the device.

| Variable | Notes |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API key (Google AI Studio). Runs the agent |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud OAuth client, type "Web application". Enable the **Gmail API**; authorized redirect URI: `<platform URL>/api/agent/gmail/callback` |
| `MAIL_TOKEN_SECRET` | 32+ random characters; encrypts mailbox tokens in the database. Changing it disconnects every mailbox |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET` | Optional: Outlook / Microsoft 365 mailboxes. Microsoft Entra app registration (accounts in any organization and personal accounts), delegated Graph permissions `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`; redirect URI (Web): `<platform URL>/api/agent/outlook/callback`. `MICROSOFT_OAUTH_TENANT` defaults to `common` |
| `MAIL_IMAP_ENABLED` | Optional: `false` hides IMAP mailboxes (Yahoo, iCloud, …). On by default; app passwords are encrypted with `MAIL_TOKEN_SECRET` |
| Google Calendar | Uses the Gmail OAuth client; enable the **Google Calendar API** in the same Google Cloud project and add the `calendar.events` scope to the consent screen |
| `FCM_SERVICE_ACCOUNT_JSON` | Optional: native new-mail push. A Firebase service account key (JSON, or base64 of it) with the Firebase Cloud Messaging API enabled. The Android build also needs `firebase.appId`, `firebase.apiKey`, `firebase.projectId`, `firebase.senderId` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair for notifications. `VAPID_SUBJECT` is optional (defaults to the platform URL) |
| `MAIL_AGENT_PROVIDER`, `MAIL_AGENT_MODEL` | Optional. Default `gemini` / `gemini-flash-latest` |
| `MAIL_AGENT_PROVIDER=openai-compatible` | Self-hosted alternative, for example `MAIL_AGENT_MODEL=qwen3:8b`. Requires `OPENAI_COMPATIBLE_BASE_URL` (and `OPENAI_COMPATIBLE_API_KEY` if the server needs one). The server must support OpenAI-style tool calling. Production (Cloudflare) cannot reach `localhost`, so the URL must be a publicly reachable HTTPS host protected by auth. Keep Gemini as the production default unless that endpoint has been checked for quality |

**One Assistant page.** `/agent` is the Assistant: one chat where one of the user's chatbots answers (owners and admins pick which, when they have several) and, once Gmail is connected, the same chat works in that user's own mailbox through the mail agent. Approvals, the Gmail connection and notifications are on that page. It needs no extra settings; the chatbot's model must support tool calling. Without a chatbot the page falls back to a mail-only chat. Only this signed-in page gets mailbox tools: the chatbot's Test chat, the website widget and the REST API never do, because they show or serve what other people get. Assistant conversations are stored under Conversations, where members of the organization can read them.

Set every one of them on **both** the Pages project and the Worker: the Worker's 10-minute cron is what checks for new mail and sends notifications.

Google setup notes:

- The agent asks for one scope, `gmail.modify` (read, label, draft, send; no permanent delete). Google classes it as **restricted**.
- While the OAuth consent screen is in **Testing**, only the test users you list can connect, and Google expires their access after 7 days (the page then shows "Reconnect Gmail"). Publishing the app for anyone to use requires Google's verification, including a security assessment for restricted scopes.
- Migration `20261112090000_mail_agent.sql` adds the four tables the agent uses.
