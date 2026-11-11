# Knowledge sources

Source documents waiting to be ingested by the RAG pipeline (Phase 4). Everything in this folder except this README is git-ignored, because source files can contain personal data.

| File | Intended scope | Notes |
|---|---|---|
| `gani-macatoman-public-record.docx` | Chatbot-specific knowledge for the Executive Assistant chatbot | Public-record compilation (v1.1, 6 Nov 2026), sources S01–S15. |

## Handling rules carried over from the source document

The document has its own usage rules, and the chatbot's system prompt and retrieval must follow them:

- Treat date-sensitive titles as historical unless a current source confirms them. Older pages that say "currently" refer to when they were published.
- Cite sources (S01–S15) for factual claims, and keep official documents separate from self-reported profiles.
- Never make up current roles, calendar events, contacts or personal preferences.
- Do not present the CITEM Board Alternate Chairmanship as the CITEM Executive Director role.
- Do not imitate the subject's voice, writing or beliefs.
- The dataset excludes family data, date of birth, contacts and IDs. Don't add them during ingestion.
