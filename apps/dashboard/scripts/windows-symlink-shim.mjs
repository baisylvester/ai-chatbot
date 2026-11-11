// Windows without Developer Mode refuses symlinks (EPERM), which OpenNext needs for pnpm's layout.
// Preloaded by build-cloudflare.mjs on Windows: fall back to a junction. pnpm's own links are junctions
// there, so their targets are absolute paths into .next/standalone; re-point them into the copied tree,
// otherwise the bundler follows them back to packages OpenNext left out on purpose (e.g. sharp).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

const symlinkSync = fs.symlinkSync;
const STANDALONE = /^.*\\\.next\\standalone\\/;
const OUTPUT_ROOT = /^.*\\\.open-next\\(?:middleware|server-functions\\[^\\]+)\\/;

fs.symlinkSync = (target, path, type) => {
  try {
    return symlinkSync(target, path, type);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    let absolute = isAbsolute(String(target)) ? String(target) : resolve(dirname(String(path)), String(target));
    const root = String(path).match(OUTPUT_ROOT)?.[0];
    if (root && STANDALONE.test(absolute)) absolute = join(root, absolute.replace(STANDALONE, ""));
    return symlinkSync(absolute, path, "junction");
  }
};
syncBuiltinESMExports();
