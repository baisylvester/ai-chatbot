# Deploying the Chatbot Platform

The platform is one Next.js app (`apps/dashboard`) and a Neon Postgres database. It serves the dashboard, the public widget API, the REST API and `embed.js`. These steps use **Vercel + Neon**. Any Node 20.9+ host works the same way: run `next build` and `next start`, and call the maintenance URL from a cron.

## 1. Database (Neon)

1. Use a Neon project in an AWS region close to your users. This repo uses `aws-ap-southeast-1`. Neon Auth, Object Storage and the AI Gateway are available there.
2. Enable Neon Auth on the production branch: `neon neon-auth enable --project-id <id> --branch main`.
3. Apply the migrations using the **direct** (unpooled) connection string:
   ```bash
   DATABASE_URL_UNPOOLED="postgresql://…" pnpm --filter @chatbot/database migrate
   ```
   Migrations are idempotent and run in order (`schema_migrations` records what's applied). Run them before deploying code that needs them.
4. Neon Auth trusted domains: run `neon neon-auth domain add https://your-domain`, or sign-in redirects fail with "invalid domain".

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string |
| `DATABASE_URL_UNPOOLED` | for migrations | Direct connection string |
| `NEON_AUTH_BASE_URL` | yes | From `neon neon-auth status` |
| `NEON_AUTH_COOKIE_SECRET` | yes | 32+ random characters (`openssl rand -base64 32`) |
| `EMBED_TOKEN_SECRET` | yes | 32+ random characters. Rotating it ends every open widget session |
| `CRON_SECRET` | yes | 32+ random characters. Vercel Cron sends it to the maintenance endpoint |
| `NEXT_PUBLIC_PLATFORM_URL` | yes | Public `https://` URL. It goes into the embed snippets and API docs |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `DEEPSEEK_API_KEY` | at least one | Chat models. Embeddings need OpenAI, Gemini or the Neon AI Gateway |
| `ELEVENLABS_API_KEY` | optional | Voice |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` | optional | Defaults to the first configured embedding provider |
| `REALTIME_DAILY_MINUTES` | optional | Realtime voice budget per organization per day (default 120) |
| `DATABASE_POOL_MAX` | optional | Connections per server instance (default 10). Keep instances × pool under Neon's pooler limit |

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
- **Backups:** Neon keeps point-in-time history for the plan's restore window, and a branch can be restored to an earlier time. Create a branch before risky migrations (`neon branches create`).
- **Scaling:** document ingestion runs inside the web process (Next.js `after()`), and maintenance catches anything missed. For heavy uploads, move ingestion to a dedicated worker (for example a Neon Function or a queue). Uploads are capped at 10 MB, 1,000 PDF pages and 100 MB of uncompressed DOCX content.

## Tests

```bash
pnpm typecheck
pnpm test                                    # DB integration tests need TEST_DATABASE_URL (use a throwaway Neon branch)
pnpm --filter @chatbot/embed-sdk build
pnpm --filter @chatbot/e2e install-browsers  # once
pnpm --filter @chatbot/e2e test:e2e          # widget in Chromium, Firefox, WebKit and mobile Chrome
```

`.github/workflows/ci.yml` runs the same checks on every push and pull request.
