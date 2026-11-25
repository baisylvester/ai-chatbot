// Windows without Developer Mode refuses symlinks (EPERM), which OpenNext needs for pnpm's layout.
// Preloaded by build-cloudflare.mjs on Windows: fall back to a junction. pnpm's own links are junctions
// there, so their targets are absolute paths into .next/standalone; re-point them into the copied tree,
// otherwise the bundler follows them back to packages OpenNext left out on purpose (e.g. sharp).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const symlinkSync = fs.symlinkSync;
const STANDALONE = /^.*\\\.next\\standalone\\/;
const OUTPUT_ROOT = /^.*\\\.open-next\\(?:middleware|server-functions\\[^\\]+)\\/;
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

// pnpm junctions may point directly at the workspace store instead of the traced
// standalone store. Keep both forms inside the copied build so OpenNext's patches
// and dependency exclusions apply to the files the bundler actually reads.
export function rebaseBuildLink(target, destination) {
  const absolute = isAbsolute(String(target)) ? String(target) : resolve(dirname(String(destination)), String(target));
  const root = String(destination).match(OUTPUT_ROOT)?.[0] ?? String(destination).match(STANDALONE)?.[0];
  if (!root) return absolute;
  if (STANDALONE.test(absolute)) return join(root, absolute.replace(STANDALONE, ""));
  const fromWorkspace = relative(workspaceRoot, absolute);
  return fromWorkspace.startsWith(`node_modules${sep}`) ? join(root, fromWorkspace) : absolute;
}

fs.symlinkSync = (target, path, type) => {
  try {
    return symlinkSync(target, path, type);
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    return symlinkSync(rebaseBuildLink(target, path), path, "junction");
  }
};
syncBuiltinESMExports();
