# Embeddable Chatbot Platform

A multi-tenant AI chatbot platform. You build the chatbot engine once, then any website can use it through a JS snippet, a Web Component, an iframe or the REST API.

## Status

**Phases 1 (Foundation) and 2 (Core platform) are done.** Phases 3–8 haven't started. Nothing on this page should be read as working beyond what this table lists.

| Area | State |
|---|---|
| pnpm + Turborepo monorepo, strict TypeScript | Done |
| `packages/shared`: Zod schemas for tenancy, chatbot settings, domains, origin allowlist check, text chunking (with Vitest tests) | Done |
| `packages/database`: Neon Postgres schema (tenancy, websites, chatbots, knowledge with pgvector + full-text search, conversations, API keys, audit, usage), RLS, migration runner, user/trusted query contexts | Done. Applied to Neon project `embeddable-chatbot` (`silent-cake-01117731`, aws-ap-southeast-1, branch `main`). RLS tests pass on a throwaway Neon branch |
| Sign-in: Neon Auth (Managed Better Auth) with email/password, `proxy.ts` route protection and a session check in every page and action | Done. Sign-up and sign-in against Neon Auth haven't been tried by a real user yet |
| `packages/core`: services for organizations, workspaces, websites + allowed domains, chatbots + settings/status, with audit logging | Done. 8 integration tests pass on a throwaway Neon branch, covering isolation, viewer read-only and conflicts |
| `apps/dashboard`: screens for organizations, workspaces, websites (domains), chatbots (settings, status, embed snippet preview) | Done. Member invitations and editing roles are not built yet |
| File storage for uploads (S3-compatible bucket) | Not started (Phase 4) |
| AI providers, LangChain.js, streaming | Not started (Phase 3) |
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

## Layout

```text
apps/dashboard        Next.js admin dashboard
packages/shared       Shared types and Zod validation (framework-free)
packages/database     SQL migrations, migration runner, query contexts (RLS)
knowledge_sources     Local source documents waiting to be ingested (git-ignored)
```

Planned packages: `chatbot-core`, `ai-engine`, `rag-engine`, `ai-providers`, `voice-engine`, `embed-sdk`, `web-component`, `react`.

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
