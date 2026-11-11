import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("knowledge-parser.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("../public/knowledge-parser.js", import.meta.url)),
  bundle: true, minify: true, platform: "browser", format: "iife", target: "es2022",
  inject: [fileURLToPath(new URL("browser-globals.mjs", import.meta.url))],
  nodePaths: [fileURLToPath(new URL("../../../packages/rag-engine/node_modules", import.meta.url)), fileURLToPath(new URL("../node_modules", import.meta.url))],
  alias: { stream: "readable-stream" }, legalComments: "eof",
});
