// Development-only mock of the OpenAI Chat Completions API (streaming + usage).
// Lets you exercise the full chat stack without a provider key:
//   node tools/mock-openai-server.mjs            (listens on http://localhost:4010)
//   OPENAI_COMPATIBLE_BASE_URL=http://localhost:4010/v1 in apps/dashboard/.env.local
// Model "fail" returns HTTP 500 (to test fallback). Any other model echoes the last user message.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4010);

createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const messages = body.messages ?? [];
  if (body.model === "fail") {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock upstream failure" } }));
    return;
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const turns = messages.filter((m) => m.role !== "system").length;
  const reply = `Mock reply to "${String(lastUser).slice(0, 200)}" (saw ${turns} conversation messages).`;
  const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
  const completionTokens = Math.ceil(reply.length / 4);
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };

  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      }),
    );
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  for (const word of reply.split(/(?<= )/)) {
    await new Promise((r) => setTimeout(r, 40));
    send({ ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  if (body.stream_options?.include_usage) {
    send({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
  }
  res.end("data: [DONE]\n\n");
}).listen(port, () => console.log(`mock OpenAI server on http://localhost:${port}/v1`));
