// launchd entry point of a plugin install. `archi on` copies this file to the plugin data folder; on every start it
// looks up the current plugin version, so a restart picks up a plugin update.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ID = process.env.ARCH_PLUGIN ?? "architect@sapfir";
let root: string | undefined;
try {
  root = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")).plugins?.[ID]?.[0]?.installPath;
} catch {}
if (!root) {
  console.error(`плагин ${ID} не установлен — хост не запускаю`);
  process.exit(0); // launchd restarts only after a failure, so a removed plugin doesn't loop
}
// Each version has its own node_modules. Claude Code installs them on install but not on update, and without them
// Bun hangs fetching packages on import, so install them here when missing.
if (!existsSync(join(root, "node_modules"))) {
  // Same package.json and bun.lock as a previous version: clone its node_modules (instant on APFS) instead of
  // a bun install that takes minutes
  const same = (dir: string) => ["package.json", "bun.lock"].every((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f), "utf8") === readFileSync(join(root, f), "utf8"));
  const prev = readdirSync(dirname(root))
    .map((v) => join(dirname(root), v))
    .find((dir) => dir !== root && existsSync(join(dir, "node_modules")) && same(dir));
  if (prev) Bun.spawnSync(["cp", process.platform === "darwin" ? "-cR" : "-R", join(prev, "node_modules"), join(root, "node_modules")], { stdout: "inherit", stderr: "inherit" });
}
if (!existsSync(join(root, "node_modules"))) {
  console.error(`ставлю зависимости версии ${root.split("/").pop()}`);
  const r = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    console.error("зависимости не поставились — хост не запускаю");
    process.exit(1); // launchd retries in 10 seconds
  }
}
process.env.ARCH_DATA ??= import.meta.dir;
await import(join(root, "src", "main.ts"));
