# Embeddable Chatbot Platform

A multi-tenant AI chatbot platform. You build the chatbot engine once, then any website can use it through a JS snippet, a Web Component, an iframe or the REST API.

## Status

**Phases 1–6 (Foundation, Core platform, AI engine, RAG engine, Universal embedding, Voice) are done.** Phases 7–8 (admin analytics, production readiness) haven't started. Nothing on this page should be read as working beyond what this table lists.

| Area | State |
|---|---|
| pnpm + Turborepo monorepo, strict TypeScript | Done |
| `packages/shared`: Zod schemas for tenancy, chatbot settings, domains, origin allowlist check, text chunking (with Vitest tests) | Done |
| `packages/database`: Neon Postgres schema (tenancy, websites, chatbots, knowledge with pgvector + full-text search, conversations, API keys, audit, usage), RLS, migration runner, user/trusted query contexts | Done. Applied to Neon project `embeddable-chatbot` (`silent-cake-01117731`, aws-ap-southeast-1, branch `main`). RLS tests pass on a throwaway Neon branch |
| Sign-in: Neon Auth (Managed Better Auth) with email/password, `proxy.ts` route protection and a session check in every page and action | Done. Sign-up and sign-in against Neon Auth haven't been tried by a real user yet |
| `packages/core`: services for organizations, workspaces, websites + allowed domains, chatbots + settings/status, with audit logging | Done. 8 integration tests pass on a throwaway Neon branch, covering isolation, viewer read-only and conflicts |
| `apps/dashboard`: screens for organizations, workspaces, websites (domains), chatbots (settings, status, embed snippet preview) | Done. Member invitations and editing roles are not built yet |
| `packages/ai-providers`: LangChain.js adapters for OpenAI, Anthropic, Gemini, DeepSeek, OpenAI-compatible servers and the Neon AI Gateway. Keys come only from server env; timeouts and retries are built in | Done. 6 unit tests |
| `packages/ai-engine`: prompt building with injection-resistant platform rules, history trimming, streaming, fallback (only before any text is sent), cancellation | Done. 9 unit tests |
| Conversation turns (`core`): sessions, messages, usage records (tokens, latency, status, failures); migration 0004 | Done. 7 integration tests on a Neon branch |
| Dashboard **Test chat** (streaming SSE, owners/admins, 20 messages/min) and provider status | Done. Tested end to end against the local mock LLM. **Not yet tried against a real provider** |
| `packages/rag-engine`: PDF/DOCX/TXT/Markdown/HTML extraction, URL import with SSRF protection, LangChain chunking, embeddings (OpenAI, Gemini, Neon AI Gateway; dev-only mock), Reciprocal Rank Fusion | Done. 18 unit tests, including a real DOCX and a PDF |
| Knowledge in `core`: global and per-chatbot sources, explicit assignment, documents, duplicate detection, background ingestion jobs, reprocessing, hybrid retrieval (pgvector + full text) scoped per chatbot, citations stored with replies; migration 0005 | Done. 8 integration tests on a Neon branch |
| Dashboard knowledge screens (org knowledge, source page with upload/URL/text, chatbot assignments) and sources shown in Test chat | Done. Tested end to end with the mock embedder and mock LLM. **Not yet run with real embeddings** |
| `packages/embed-sdk`: one framework-free `embed.js` (28 KB, 9.6 KB gzipped, including voice) with script auto-mount, `<ai-chatbot>` Web Component (Shadow DOM), and an iframe helper with validated `postMessage` | Done. 4 unit tests. Tested in the browser on a separate origin with hostile CSS |
| Public widget API (`/api/v1/embed/config`, `/sessions`, `/messages`): CORS, Origin allowlist re-checked on every request, HMAC session tokens (2 h), rate limits, generic public errors | Done. 7 integration tests on a Neon branch |
| iframe page (`/embed/frame`) with CSP `frame-ancestors` from the allowed domains | Done. Tested allowed and blocked framing in the browser |
| Server-to-server REST API (`POST /api/v1/chat`) with private API keys (hashed, revocable, organization-scoped); JSON or SSE | Done. Tested create, use, stream, revoke |
| `packages/react` wrapper, `apps/embed-demo` plain HTML demo site, dashboard install panel with copy buttons and API key management | Done |
| `packages/voice-engine`: speech-to-text, text-to-speech (OpenAI, ElevenLabs, dev mock) and OpenAI Realtime client secrets, with declared capabilities and a voice catalog | Done. 13 unit tests that check request formats against mocked HTTP |
| Voice in `core` and the widget API: standard mode (tap to talk → chat with knowledge → reply read aloud) and realtime mode (WebRTC call; a `search_knowledge` tool scoped to the chatbot; transcript saved when the call ends); voice settings per chatbot; usage by kind (stt/tts/realtime); migration 0008 | Done. 4 integration tests on a Neon branch. Tested in the browser with the mock provider: auto read-aloud, mute, blocked-microphone message, realtime unavailable message. **Not yet tested with real OpenAI/ElevenLabs keys or a real microphone** |
| Admin analytics, production hardening | Not started (Phases 7–8) |

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

## Knowledge base

- **Sources:** shared (organization-wide) or chatbot-only. A chatbot searches its own sources plus shared sources explicitly assigned to it on its page, and nothing else.
- **Documents:** PDF, DOCX, TXT, Markdown or HTML files up to 10 MB, public web pages, or pasted text.
- **Processing:** files are extracted when uploaded. Chunking and embedding run in the background through Next.js `after()`, with a job row in `ingestion_jobs`. Use **Reprocess** to retry a document or refresh a web page.
- **Retrieval:** pgvector cosine search and Postgres full-text search, merged with Reciprocal Rank Fusion. If no embedding provider is available, keyword search alone is used.
- **Embeddings:** the provider is chosen from `EMBEDDING_PROVIDER`, otherwise the first one configured of OpenAI (`text-embedding-3-small`), Gemini (`gemini-embedding-001`) or the Neon AI Gateway. All of them produce 1536 dimensions. Anthropic and DeepSeek have no embedding API. `EMBEDDING_PROVIDER=mock` is for development only: it matches words, not meaning.
- **Changing the embedding model:** reprocess your documents afterwards. Chunks remember which model produced them, and vectors from different models are never compared.

Known limits:
- Original files aren't stored; only the extracted text is kept. Moving originals to Neon Object Storage is planned.
- Scanned PDFs need OCR, which isn't supported.
- Background ingestion runs inside the web server process. A queue worker (for example a Neon Function on a cron) is needed for multiple instances or very large files.
- URL import checks DNS on every redirect but doesn't pin the resolved address, so a narrow DNS-rebinding window remains.
- The semantic similarity cut-off (0.2) is a starting point and should be tuned once real embeddings are in use.

## Embedding on a website

Every chatbot page has an **Install on a website** panel with ready-to-copy snippets. The chatbot must be **active**, and the site's domain must be in the website's allowed domains. Subdomains are included automatically. `localhost` is accepted for development.

| Method | Use it for |
|---|---|
| JavaScript snippet (`window.AIChatbotConfig` + `embed.js`) | Any site: plain HTML, WordPress (header/footer plugin), Shopify (`theme.liquid`), Webflow/Wix custom code, PHP/Laravel, Django, ASP.NET, static sites |
| `<ai-chatbot>` Web Component | Placing the chat inline or controlling it from your own code. Theme it with CSS variables (`--aic-accent`, `--aic-font`, `--aic-width`, …) |
| iframe (`/embed/frame?chatbotId=…`) | Locked-down sites. Only allowed domains can frame it |
| `@chatbot/react` (`<AIChatbot />`) | React and Next.js (render it from a Client Component). Vue, Svelte and Angular can use the Web Component directly |
| REST API (`POST /api/v1/chat` + private key) | Your own backend or apps. Keep keys on the server |

Try it locally:
1. Run `node apps/embed-demo/server.mjs`.
2. Open `http://localhost:4020/index.html?bot=cb_…` (use a chatbot whose website allows `localhost`).

The demo pages deliberately use aggressive global CSS to show that the widget's styling is isolated.

Security notes:
- The public chatbot ID is not a secret and grants nothing by itself.
- Origin checks stop other websites' browsers from using a chatbot. They can't stop scripts that fake headers; rate limits cover those.
- Pausing a chatbot or removing a domain takes effect on the next message.
- Widget sessions are signed with `EMBED_TOKEN_SECRET`, which must be 32+ characters and set in production.
- Rate limits are in memory per server process until a shared store is added.

## Voice

Each chatbot has a **Voice** section in its settings:

| Mode | How it works | Needs |
|---|---|---|
| Off | Text only | — |
| Standard | The visitor taps the mic, speech is transcribed, and the normal chat (knowledge, citations, fallback) answers. The reply is read aloud, and the visitor can mute it | Speech-to-text and text-to-speech providers: OpenAI (`OPENAI_API_KEY`) or ElevenLabs (`ELEVENLABS_API_KEY` plus a voice ID) |
| Realtime | A live voice call. The browser connects straight to OpenAI Realtime over WebRTC with a short-lived client secret minted by the server. The model looks things up through `search_knowledge`, which runs on the platform and only searches that chatbot's knowledge. The transcript is saved to the conversation when the call ends | `OPENAI_API_KEY` |

Notes:
- **Keys:** permanent API keys never reach the browser. Realtime client secrets live for 60 seconds and are only good for starting one call.
- **Microphone:** the visitor's browser asks for permission. If it's blocked, the widget explains how to allow it and typing still works.
- **iframes:** the host page must grant the microphone with `allow="microphone"` (the dashboard snippet includes it).
- **Disconnects:** a dropped call is reported in the chat and can be restarted. Interruptions (barge-in) are handled by the realtime model's voice activity detection.
- **Development:** `VOICE_MOCK=1` enables a mock provider (a fixed transcript and a test tone) for development only.
- **Usage:** recorded per request: speech-to-text (audio seconds reported by the browser), text-to-speech (characters) and realtime (call duration).
- **Settings delay:** visitors see a settings change within about a minute, because the public config is cached.

## Layout

```text
apps/dashboard        Next.js admin dashboard
packages/shared       Shared types and Zod validation (framework-free)
packages/database     SQL migrations, migration runner, query contexts (RLS)
packages/core         Tenant services and conversation turns
packages/ai-providers LangChain.js provider adapters
packages/ai-engine    Prompt building, streaming, fallback
packages/rag-engine   Extraction, URL import, chunking, embeddings, ranking
packages/embed-sdk    embed.js: script snippet, <ai-chatbot> Web Component, iframe helper, voice UI
packages/voice-engine Speech-to-text, text-to-speech, realtime voice adapters
packages/react        React / Next.js wrapper
apps/embed-demo       Plain HTML demo site on its own origin (port 4020)
tools/                Development helpers (mock LLM server, API key setup)
knowledge_sources     Local source documents waiting to be ingested (git-ignored)
```


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
