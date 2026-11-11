// Bundles the widget into one framework-free script served by the platform at /embed.js.
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const outFiles = [join(pkg, "dist", "embed.js"), join(pkg, "..", "..", "apps", "dashboard", "public", "embed.js")];

for (const outfile of outFiles) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(pkg, "src", "index.ts")],
    outfile,
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2020", "chrome90", "firefox88", "safari15", "edge90"],
    legalComments: "none",
    banner: { js: "/* AI Chatbot embed v0.1.0 */" },
  });
}
console.log(`embed.js built (${(statSync(outFiles[0]).size / 1024).toFixed(1)} KB)`);
