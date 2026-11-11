# Embeddable Chatbot Platform

A multi-tenant AI chatbot platform. You build the chatbot engine once, then any website can use it through a JS snippet, a Web Component, an iframe or the REST API.

## Status

**Phases 1 (Foundation), 2 (Core platform) and 3 (AI engine) are done.** Phases 4–8 haven't started. Nothing on this page should be read as working beyond what this table lists.

| Area | State |
|---|---|
| pnpm + Turborepo monorepo, strict TypeScript | Done |
| `packages/shared`: Zod schemas for tenancy, chatbot settings, domains, origin allowlist check, text chunking (with Vitest tests) | Done |
| `packages/database`: Neon Postgres schema (tenancy, websites, chatbots, knowledge with pgvector + full-text search, conversations, API keys, audit, usage), RLS, migration runner, user/trusted query contexts | Done. Applied to Neon project `embeddable-chatbot` (`silent-cake-01117731`, aws-ap-southeast-1, branch `main`). RLS tests pass on a throwaway Neon branch |
| Sign-in: Neon Auth (Managed Better Auth) with email/password, `proxy.ts` route protection and a session check in every page and action | Done. Sign-up and sign-in against Neon Auth haven't been tried by a real user yet |
| `packages/core`: services for organizations, workspaces, websites + allowed domains, chatbots + settings/status, with audit logging | Done. 8 integration tests pass on a throwaway Neon branch, covering isolation, viewer read-only and conflicts |
| `apps/dashboard`: screens for organizations, workspaces, websites (domains), chatbots (settings, status, embed snippet preview) | Done. Member invitations and editing roles are not built yet |
| File storage for uploads (S3-compatible bucket) | Not started (Phase 4) |
| `packages/ai-providers`: LangChain.js adapters for OpenAI, Anthropic, Gemini, DeepSeek, OpenAI-compatible servers and the Neon AI Gateway. Keys come only from server env; timeouts and retries are built in | Done. 6 unit tests |
| `packages/ai-engine`: prompt building with injection-resistant platform rules, history trimming, streaming, fallback (only before any text is sent), cancellation | Done. 9 unit tests |
| Conversation turns (`core`): sessions, messages, usage records (tokens, latency, status, failures); migration 0004 | Done. 7 integration tests on a Neon branch |
| Dashboard **Test chat** (streaming SSE, owners/admins, 20 messages/min) and provider status | Done. Tested end to end against the local mock LLM. **Not yet tried against a real provider** |
| Ingestion, embeddings, hybrid retrieval, citations | Not started (Phase 4) |
| Embed SDK, Web Component, iframe, REST API | Not started (Phase 5) |
| Voice, analytics, production hardening | Not started (Phases 6–8) |

## Stack change: Neon instead of Supabase

Neon is the database (PostgreSQL + pgvector). It does not provide Supabase's Auth, Storage or Realtime, so those are covered as follows:

| Supabase feature | Replacement |
|---|---|
| Postgres + pgvector | Neon (`vector` extension) |
| `auth.users` / `auth.uid()` | `users` table, plus `app.user_id` set per transaction (`current_app_user_id()`) |
| `anon` / `authenticated` roles | `chatbot_app` role, which is subject to RLS |
| `service_role` | The owner role (owns the tables, so it bypasses RLS). Used only by trusted server code |
| Supabase Auth | To be chosen in Phase 2. Neon Auth (Better Auth) is the default candidate |
| Supabase Storage | S3-compatible object storage (Phase 4). `knowledge_documents.storage_key` holds the object key |
| Supabase Realtime | Streaming over HTTP (SSE) from the API (Phase 3/5) |

## Neon tooling

- `neon` CLI 8.13.1 (global). `.neon` links this folder to the project. Running `neon link` writes `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `NEON_BRANCH` to the root `.env.local`.
- `.mcp.json`: the Neon MCP server (`https://mcp.neon.tech/mcp`) uses OAuth, so no API key is stored in the repo. Claude Code asks you to sign in to Neon the first time it's used.
- `.claude/skills/`: the Neon agent skills `neon`, `neon-postgres`, `neon-auth` and `neon-object-storage`, pinned in `skills-lock.json`. Run `neon skills status` to check them and `neon skills update -y` to update.
- Branch-first workflow: run `neon checkout <feature> --create` for each feature, and `neon diff` to review schema changes.

## AI providers

Set any of these in `apps/dashboard/.env.local`. The dashboard shows which providers are configured, and a chatbot can only use configured ones.

| Provider | Variables |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` (optional `DEEPSEEK_BASE_URL`) |
| OpenAI-compatible (Ollama, vLLM, LM Studio…) | `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY` |
| Neon AI Gateway | `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN`. Requires prepaid AI Gateway credits on the Neon account; without them, requests return 403 |

To add a key without opening the file, run `powershell -NoProfile -ExecutionPolicy Bypass -File toolsset-provider-key.ps1`. It asks which provider the key is for, reads the key with hidden input, and writes it into `apps/dashboard/.env.local`.

**Pending:** the chat hasn't yet been run against a real provider. Once a key is set, try the Test chat on a chatbot that uses that provider.

To try the chat without any provider account, run the development mock with `node tools/mock-openai-server.mjs` and set `OPENAI_COMPATIBLE_BASE_URL=http://localhost:4010/v1`. The model `fail` returns HTTP 500, which is useful for testing fallback.

Known limits:
- The rate limiter is in memory, so it only works for a single server process.
- API keys are platform-wide for now. Per-organization keys need encrypted storage and are planned for later.

## Layout

```text
apps/dashboard        Next.js admin dashboard
packages/shared       Shared types and Zod validation (framework-free)
packages/database     SQL migrations, migration runner, query contexts (RLS)
packages/core         Tenant services and conversation turns
packages/ai-providers LangChain.js provider adapters
packages/ai-engine    Prompt building, streaming, fallback
tools/                Development helpers (mock LLM server, API key setup)
knowledge_sources     Local source documents waiting to be ingested (git-ignored)
```

Planned packages: `rag-engine`, `voice-engine`, `embed-sdk`, `web-component`, `react`.

## Getting started

```bash
pnpm install
cp .env.example apps/dashboard/.env.local   # set DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct)
DATABASE_URL_UNPOOLED="postgres://..." pnpm --filter @chatbot/database migrate
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

The RLS integration tests run only when `TEST_DATABASE_URL` points at a throwaway database, such as a Neon branch. They apply migrations and create and delete test rows.

## Security model

- A public chatbot ID identifies a chatbot. It does not grant access. Chat access will require an allowlisted origin plus a short-lived session token.
- Every tenant table has an `organization_id`. User requests run through `withUserContext`, which switches to `chatbot_app` and sets `app.user_id`. RLS then limits reads to organization members and writes to owners and admins.
- Conversations, document chunks, usage records and organization creation run through `withTrustedContext` (the owner role). That code must scope every query by organization itself.
- `chatbot_app` can't select API key hashes.
- Global knowledge reaches a chatbot only through an explicit row in `chatbot_knowledge_assignments`.
