import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import "./build-parser.mjs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const env = { ...process.env, ...config.vars, SKIP_ENV_CHECK: "1" };
if (process.platform === "win32") {
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import ${new URL("./windows-symlink-shim.mjs", import.meta.url).href}`.trim();
}
const result = spawnSync(process.execPath, [process.env.npm_execpath, "exec", "opennextjs-cloudflare", "build"], {
  stdio: "inherit", env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
