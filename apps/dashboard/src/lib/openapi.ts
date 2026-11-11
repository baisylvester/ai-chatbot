/**
 * OpenAPI 3.1 description of the public API (widget + server-to-server). Served at
 * /api/v1/openapi.json and rendered on /docs. Dashboard-only routes are intentionally excluded.
 */
const error = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } } },
} as const;

const citation = {
  type: "object",
  properties: { n: { type: "integer" }, title: { type: "string" }, sourceUrl: { type: ["string", "null"] }, snippet: { type: "string" } },
} as const;

const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description:
          ({ 400: "Invalid request", 401: "Missing, invalid or expired credentials", 403: "Origin not allowed or feature disabled", 404: "Chatbot not available", 429: "Rate limited (see Retry-After)", 502: "The model could not answer", 503: "Voice provider unavailable" } as Record<number, string>)[c],
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    ]),
  );

export function openApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Chatbot Platform API",
      version: "1.0.0",
      description:
        "Public API for embedding chatbots and calling them from your own servers. Widget endpoints are called by embed.js from allowed website origins with a short-lived session token. The chat endpoint is for servers and uses a private API key.",
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "Widget", description: "Used by embed.js in visitors' browsers. Requires an allowed Origin." },
      { name: "Voice", description: "Voice features for widgets (standard and realtime modes)." },
      { name: "Server", description: "Server-to-server chat with a private API key. Not available from browsers (no CORS)." },
    ],
    components: {
      securitySchemes: {
        sessionToken: { type: "http", scheme: "bearer", description: "Widget session token from POST /api/v1/embed/sessions (valid 2 hours)." },
        apiKey: { type: "http", scheme: "bearer", description: "Private API key (cbk_…) created on the organization page. Keep it on your server." },
      },
      schemas: {
        Error: error,
        Citation: citation,
        PublicConfig: {
          type: "object",
          properties: {
            chatbotId: { type: "string", example: "cb_2fbMQwykdHpcoCXs3zbs2NW8" },
            name: { type: "string" },
            welcomeMessage: { type: "string" },
            suggestedQuestions: { type: "array", items: { type: "string" } },
            theme: { enum: ["light", "dark", "auto"] },
            position: { enum: ["bottom-right", "bottom-left"] },
            voice: { type: "object", properties: { mode: { enum: ["off", "standard", "realtime"] }, autoSpeak: { type: "boolean" } } },
          },
        },
      },
    },
    paths: {
      "/api/v1/embed/config": {
        get: {
          tags: ["Widget"],
          summary: "Get public chatbot settings",
          parameters: [{ name: "chatbotId", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Settings for an active chatbot on an allowed origin", content: { "application/json": { schema: { $ref: "#/components/schemas/PublicConfig" } } } }, ...errors(403, 404, 429) },
        },
      },
      "/api/v1/embed/sessions": {
        post: {
          tags: ["Widget"],
          summary: "Start a widget conversation",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["chatbotId"], properties: { chatbotId: { type: "string" }, visitorId: { type: "string", description: "Optional random browser id (16–64 chars) for unique-visitor counts; stored only as a keyed hash." } } } } },
          },
          responses: {
            "200": {
              description: "Session token",
              content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" }, expiresAt: { type: "string", format: "date-time" }, config: { $ref: "#/components/schemas/PublicConfig" } } } } },
            },
            ...errors(400, 403, 404, 429),
          },
        },
      },
      "/api/v1/embed/messages": {
        post: {
          tags: ["Widget"],
          summary: "Send a message and stream the reply",
          description: "Server-Sent Events: `sources` {citations}, `token` {text} (repeated), then `done` {} or `error` {code, message}.",
          security: [{ sessionToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string", maxLength: 4000 } } } } } },
          responses: { "200": { description: "Event stream", content: { "text/event-stream": { schema: { type: "string" } } } }, ...errors(400, 401, 403, 404, 429) },
        },
      },
      "/api/v1/embed/voice/transcribe": {
        post: {
          tags: ["Voice"],
          summary: "Transcribe a recording (standard voice mode)",
          security: [{ sessionToken: [] }],
          requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["audio"], properties: { audio: { type: "string", format: "binary" }, durationMs: { type: "integer" } } } } } },
          responses: { "200": { description: "Transcript", content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } } }, ...errors(400, 401, 403, 429, 503) },
        },
      },
      "/api/v1/embed/voice/speech": {
        post: {
          tags: ["Voice"],
          summary: "Read text aloud (standard voice mode)",
          security: [{ sessionToken: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          responses: { "200": { description: "Audio", content: { "audio/mpeg": {}, "audio/wav": {} } }, ...errors(400, 401, 403, 429, 503) },
        },
      },
      "/api/v1/embed/voice/realtime": {
        post: {
          tags: ["Voice"],
          summary: "Start a realtime voice call",
          description: "Returns a short-lived provider client secret. The browser posts its WebRTC SDP offer to `callsUrl` with `Authorization: Bearer <clientSecret>`.",
          security: [{ sessionToken: [] }],
          responses: {
            "200": {
              description: "Call credentials",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { voiceSessionId: { type: "string" }, clientSecret: { type: "string" }, expiresAt: { type: "integer" }, callsUrl: { type: "string" }, model: { type: "string" }, voice: { type: "string" } },
                  },
                },
              },
            },
            ...errors(401, 403, 429, 503),
          },
        },
      },
      "/api/v1/embed/voice/realtime/tool": {
        post: {
          tags: ["Voice"],
          summary: "Run a knowledge lookup for the realtime model",
          security: [{ sessionToken: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["voiceSessionId", "name", "arguments"], properties: { voiceSessionId: { type: "string" }, name: { const: "search_knowledge" }, arguments: { type: "string", description: "JSON string, e.g. {\"query\":\"opening hours\"}" } } } } },
          },
          responses: { "200": { description: "Tool output", content: { "application/json": { schema: { type: "object", properties: { output: { type: "string" }, citations: { type: "array", items: { $ref: "#/components/schemas/Citation" } } } } } } }, ...errors(400, 401, 404, 429) },
        },
      },
      "/api/v1/embed/voice/realtime/end": {
        post: {
          tags: ["Voice"],
          summary: "End a realtime call and save its transcript",
          security: [{ sessionToken: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["voiceSessionId"],
                  properties: { voiceSessionId: { type: "string" }, failed: { type: "boolean" }, transcript: { type: "array", items: { type: "object", properties: { role: { enum: ["user", "assistant"] }, text: { type: "string" } } } } },
                },
              },
            },
          },
          responses: { "200": { description: "Call recorded", content: { "application/json": { schema: { type: "object", properties: { durationSeconds: { type: "integer" } } } } } }, ...errors(400, 401, 404) },
        },
      },
      "/api/v1/chat": {
        post: {
          tags: ["Server"],
          summary: "Chat with a chatbot from your server",
          description: "Set `stream: true` for Server-Sent Events (`session`, `sources`, `token`, `done`, `error`). Pass the returned `sessionId` to continue a conversation.",
          security: [{ apiKey: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["chatbotId", "message"],
                  properties: { chatbotId: { type: "string" }, message: { type: "string", maxLength: 4000 }, sessionId: { type: "string", format: "uuid" }, stream: { type: "boolean", default: false } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Reply",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessionId: { type: "string" },
                      reply: { type: "string" },
                      citations: { type: "array", items: { $ref: "#/components/schemas/Citation" } },
                      usage: { type: ["object", "null"], properties: { inputTokens: { type: "integer" }, outputTokens: { type: "integer" } } },
                    },
                  },
                },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            ...errors(400, 401, 404, 429, 502),
          },
        },
      },
    },
  };
}
