// Packages the OpenNext build for Cloudflare Pages (advanced mode). Run build:cloudflare first.
// Output: cloudflare-pages/dist (static assets + bundled _worker.js) and a generated Pages wrangler.jsonc.
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const pages = join(root, "cloudflare-pages");
const dist = join(pages, "dist");
const worker = join(dist, "_worker.js");
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));

rmSync(pages, { recursive: true, force: true });
mkdirSync(pages, { recursive: true });
cpSync(join(root, ".open-next", "assets"), dist, { recursive: true });

// Let wrangler bundle the worker exactly as it does for a Workers deploy, then upload that as is.
const bundled = spawnSync(process.execPath, [process.env.npm_execpath, "exec", "wrangler", "deploy", "--dry-run", "--outdir", worker], {
  cwd: root, stdio: "inherit",
});
if (bundled.error) throw bundled.error;
if (bundled.status) process.exit(bundled.status);
const entry = readdirSync(worker).find((name) => /^cloudflare-worker\.m?js$/.test(name));
if (!entry) throw new Error("wrangler did not emit the worker bundle");
renameSync(join(worker, entry), join(worker, "index.js"));
for (const name of readdirSync(worker)) if (name.endsWith(".map") || name === "README.md") rmSync(join(worker, name));

// Static files are served by Pages without invoking (or billing) the worker.
const statics = readdirSync(dist, { withFileTypes: true })
  .filter((item) => item.name !== "_worker.js")
  .map((item) => (item.isDirectory() ? `/${item.name}/*` : `/${item.name}`));
writeFileSync(join(dist, "_routes.json"), JSON.stringify({ version: 1, include: ["/*"], exclude: statics }, null, 2));
// Same headers next.config.ts sets for the widget script.
writeFileSync(join(dist, "_headers"), [
  "/embed.js",
  "  Cache-Control: public, max-age=300, stale-while-revalidate=86400",
  "  X-Content-Type-Options: nosniff",
  "  Access-Control-Allow-Origin: *",
  "/_next/static/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n"));

// Pages has no cron triggers; the Worker deployment of the same build keeps running maintenance.
writeFileSync(join(pages, "wrangler.jsonc"), JSON.stringify({
  name: config.name,
  pages_build_output_dir: "./dist",
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  hyperdrive: config.hyperdrive,
  vars: config.vars,
}, null, 2));
console.log(`Pages bundle ready in ${dist}`);
