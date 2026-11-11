# Handoff: Embeddable Chatbot Platform

State as of 2026-11-11. Read this first, then `README.md`, `DEPLOYMENT.md` and `SECURITY.md`.

## Update (2026-11-11, after deployment)

This section supersedes older statements below where they differ.

- **Deployed:** production is Cloudflare Pages, https://ai-chatbot-9wg.pages.dev (project `ai-chatbot`). The Worker `ai-chatbot` runs the 10-minute maintenance cron from the same build. Both reach Supabase through Hyperdrive `ai-chatbot-db`. See "Cloudflare Pages" in `DEPLOYMENT.md`.
- **Checked on production:** `/api/health` (database ok), the home, sign-in, sign-up and docs pages, `embed.js`, the OpenAPI document, the widget config endpoint (a transactional query through Hyperdrive) and the maintenance endpoint on both deployments.
- **Tests:** the full suite, including the 40 database integration tests that used to be skipped, passes (126 tests) on a throwaway Neon branch, which was deleted afterwards. `packages/core/vitest.config.ts` now runs test files one at a time, because maintenance purges every organization and raced the retention test.
- **Landing page:** the build-progress list now shows all eight phases as built.
- **Still open, needs the owner:**
  1. Supabase Auth: set the Site URL to the Pages URL and allow `https://ai-chatbot-9wg.pages.dev/auth/callback`, then run sign-up end to end.
  2. Add at least one AI provider key (`wrangler pages secret put` and `wrangler secret put`). Until then chat, embeddings and voice cannot answer in production, and none of them has been tried against a real provider.
  3. Custom SMTP in Supabase before real users sign up.
- **Still open, engineering:** server-side realtime voice connection (`SECURITY.md`, finding 2); owner guard before any member-management screen.

## Where things stand

- **Repo:** `C:\Users\PC2\AndroidStudioProjects\PROJECTS\embeddable_chatbot`, git branch `main`, last commit `33d195d` (Phase 8).
- **All 8 build phases are present in code and committed.** The Supabase move and the direct admin knowledge-upload interface are included in this repository snapshot (see "Included changes"). Implemented does not mean all release validation is complete.
- **Supabase project:** `sylv_project`, ref `gmuqwpfllgmvhzhehepp`, pooler host `aws-0-ap-south-1.pooler.supabase.com`.
- **Database:** all 12 migrations are applied to `sylv_project` (checked read-only: 23 tables in `public`, 0 auth users, 0 organizations).
- **Env:** `apps/dashboard/.env.local` has `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EMBED_TOKEN_SECRET` and `NEXT_PUBLIC_PLATFORM_URL` set. All AI provider keys are empty.
- **Checks that pass now:** `pnpm typecheck` (11 of 11 tasks), production build (with build-time env validation skipped), and `pnpm test` (86 passed; 40 database-suite tests skipped because no throwaway `TEST_DATABASE_URL` is configured). Targeted live Supabase checks verified PDF/DOC/DOCX/TXT extraction → ingestion → retrieval, chatbot isolation, status counts and viewer denial, using a mock embedder and one transaction that was rolled back. Verification left 0 auth users, app users, organizations and documents.
- **Dev server:** running at `http://localhost:3100`; it was stopped for the build and restarted afterward. The temporary upload preview route used for browser QA was removed and returns 404.
- **Browser checks:** PDF, DOC, DOCX and TXT each passed browser → server extraction in the temporary upload preview; invalid extension and new-source controls were checked. The existing widget suite passed 15 tests with 3 intentionally skipped across Chromium, WebKit and mobile Chrome. Firefox was not run locally. Missing Chromium/WebKit binaries for the pinned Playwright version were installed before rerunning.

## Phase reassessment (2026-11-11)

| Phase | Implementation evidence | Validation status |
|---|---|---|
| 1 — Foundation and database | pnpm/Turbo workspace; shared schemas; database migrations, TLS and RLS contexts | Present. Supabase has 12 migrations and 23 RLS-enabled tables; connection and rollback isolation checks passed |
| 2 — Core admin platform | Core tenant services; organization/workspace/website/chatbot pages, actions and settings | Present. Supabase email-confirmation sign-up and signed-in navigation still need a real account test |
| 3 — AI and conversations | AI adapters, streaming engine, usage/conversation services and Test chat | Present and unit-tested. Live provider test remains blocked by empty provider keys |
| 4 — Knowledge and RAG | Extractors, source/document services, ingestion, hybrid retrieval, assignments and admin screens | Present and enhanced. Direct chatbot upload now supports PDF/DOC/DOCX/TXT; UI extraction and rollback-only Supabase pipeline checks passed. Real embeddings remain untested |
| 5 — Embedding and public API | embed-sdk, React wrapper, widget/config/session/message endpoints, iframe, API keys and REST chat | Present. Widget browser suite: 15 passed, 3 skipped across Chromium/WebKit/mobile Chrome. Admin-upload UI extraction was verified separately |
| 6 — Voice | voice-engine; STT/TTS/realtime routes, widget controls and settings | Present and mock/unit-tested. Real microphone/provider tests and server-side realtime connection remain open |
| 7 — Analytics and history | analytics services/pages, transcripts, retention, docs and OpenAPI route | Present. Broad database integration suite has not been rerun on a dedicated Supabase test database |
| 8 — Production readiness | Security headers/env validation, maintenance, rate limits, health endpoint, CI and browser tests | Present. Local production build and health checks pass; deployment remains open. Security Advisor previously reported 0 errors and 0 warnings |

The Phase 4 backend and source-page uploader already existed. This update adds a visible, direct upload panel on each chatbot page, reuses it on source pages, supports legacy `.doc`, checks admin permission before parsing, and reports missing embedding configuration accurately. Original uploaded file bytes are not retained; extracted text is stored for ingestion.

## Not done yet (next steps, in order)

1. **Run the full database integration suite on a throwaway database.** It needs `TEST_DATABASE_URL` and creates/deletes fixture rows. Do not confuse the 40 skipped tests with the targeted live rollback checks already completed.
   ```bash
   pnpm test
   ```
   The `vector` extension now lives in `extensions`; owner and restricted-role vector queries were verified successfully on Supabase.
2. **Supabase Auth settings:** `http://localhost:3100/auth/callback` is allowed, with owner approval. The local app uses `NEXT_PUBLIC_PLATFORM_URL=http://localhost:3100`. The default Supabase Site URL remains `http://localhost:3000`; set the production Site URL and callback when deploying. Email confirmation remains on.
3. **Try sign-up end to end** in a browser: sign up, click the emailed link, land on `/orgs`, create an organization, sign out, sign in. This has never been run on Supabase Auth.
4. **Advisors:** security warnings were fixed (helper search path and extension location); the last Security Advisor result was 0 errors and 0 warnings. Overlapping permissive RLS policies remain performance-optimization suggestions.
5. **Rerun the browser tests when widget code changes** (they mock the API, so they don't depend on the database). Current Chromium/WebKit/mobile Chrome result: 15 passed, 3 skipped:
   ```bash
   pnpm --filter @chatbot/embed-sdk build
   ```
   ```bash
   pnpm --filter @chatbot/e2e test:e2e
   ```
   Firefox is blocked by Windows policy on this PC. Don't change system security settings; CI covers Firefox.
6. **Repository:** the owner requested committing and pushing this snapshot to `https://github.com/baisylvester/ai-chatbot` on `main`. Keep the remaining validation limits above visible in future releases.
7. **Still open from before:** add a real AI provider key and test live chat, deploy (`DEPLOYMENT.md`), and replace browser-side realtime voice with a server-side connection (`SECURITY.md`, finding 2).

## Included changes

| Area | Files | What changed |
|---|---|---|
| Sign-in | `apps/dashboard/src/lib/auth/server.ts`, `src/proxy.ts`, `src/lib/session.ts`, `src/app/auth/actions.ts`, `src/app/auth/sign-in/page.tsx`, new `src/app/auth/callback/route.ts`, deleted `src/app/api/auth/[...path]/route.ts` | Neon Auth replaced by Supabase Auth through `@supabase/ssr` 0.12.7 and `@supabase/supabase-js` 2.118.0. Sessions are verified with `getClaims()`. Sign-up shows "check your email" when there is no session yet |
| Env checks | `apps/dashboard/src/lib/env.ts`, `.env.example` | `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` replace the two `NEON_AUTH_*` variables |
| TLS | `packages/database/src/client.ts`, new `src/supabase-ca.ts`, `src/index.ts`, `src/migrate.ts`, new `test/connection.test.ts` | `connectionConfig()` trusts the bundled Supabase root CA for `*.supabase.com` and `*.supabase.co` hosts, with full certificate and hostname checks. `DATABASE_CA_CERT` overrides it |
| Migrations | new `0011_close_data_api.sql`, new `20261111080640_harden_supabase_schema.sql`, `src/migrate.ts` | 0011 removes the `anon` and `authenticated` roles' access to `public`. The second pins `current_app_user_id()`'s search path and moves `vector` to the `extensions` schema. The runner now also accepts 14-digit timestamp names |
| Tooling | `.mcp.json`, new `tools/set-supabase-password.ps1` | MCP entry points at Supabase instead of Neon. The script prompts for the database password, verifies it, and writes the env files |
| Admin knowledge upload | New `components/knowledge-upload.tsx`, chatbot/source pages, `knowledge-actions.ts`, core knowledge source counts, dashboard upload tests | Direct file picker/drop area; existing/new source selection; pending/errors/success and document-status link; owner/admin check before parsing; no permission bypass added |
| File extraction | RAG `formats.ts`, `legacy-doc.ts`, extraction and tests; pinned `word-extractor` 1.0.4; licensed DOC/DOCX fixtures | Browser-safe shared upload policy, OLE validation, isolated legacy DOC parsing, malformed-file tests and deployment tracing for the worker's parser |
| Docs | `README.md`, `DEPLOYMENT.md`, `SECURITY.md`, `.github/workflows/ci.yml`, small comment edits | Describe Supabase instead of Neon |

The Supabase changes and new admin uploader are included in this snapshot. Checks and their limits are recorded above; the entire application has not received a new independent security review.

## How the app is built

- **Monorepo:** pnpm 11 and Turborepo. One Next.js 16 app in `apps/dashboard`; packages in `packages/` (`shared`, `database`, `core`, `ai-providers`, `ai-engine`, `rag-engine`, `voice-engine`, `embed-sdk`, `react`); browser tests in `tests/e2e`.
- **Database access:** the server talks to Postgres directly with `pg`. Supabase's Data API is not used.
- **Tenancy:** organizations → workspaces → websites → chatbots. Every tenant table has `organization_id` and row-level security.
- **Two database contexts** (`packages/database/src/client.ts`):
  - `withUserContext` runs as the restricted `chatbot_app` role with `app.user_id` set, so RLS applies. Use it for dashboard requests.
  - `withTrustedContext` runs as the owner role and bypasses RLS. Use it only for trusted server work, and filter by `organization_id` explicitly.
  - Never nest the two. Where both are needed, an `authorizeX` call returns a grant, and the trusted write takes that grant in a separate transaction.
- **Users:** Supabase Auth owns sign-in. `lib/session.ts` mirrors each verified user into `public.users`.
- **Widget:** `embed.js` (Shadow DOM), origin allowlist re-checked on every request, HMAC session tokens, no cookies.

## Rules to keep

- Never print, log or commit secrets. `.env.local` and `knowledge_sources/` (a personal document) are git-ignored and must stay that way.
- Pin dependency versions exactly, to releases at least two weeks old.
- Stop the dev server before `next build`, and restart it after; building while it runs breaks it.
- The old Neon values are commented out at the bottom of `apps/dashboard/.env.local` for rollback. Data in the old Neon project was not copied over.
- Commit only when the owner asks.

## Commands

```bash
pnpm install
```
```bash
pnpm typecheck
```
```bash
pnpm --filter @chatbot/database migrate
```
```bash
pnpm --filter @chatbot/dashboard dev
```
