// Architect as a Claude Code plugin: code in the version folder, everything persistent in the plugin data folder.
import { expect, test } from "bun:test";
import { DATA, WORK, ARCH_HOME, pluginData } from "../src/config";

test("finds the plugin data folder from the version folder, as Claude Code names it", () => {
  expect(pluginData("/Users/x/.claude/plugins/cache/sapfir/architect/0f3c2a1b9e7d", "/Users/x")).toBe("/Users/x/.claude/plugins/data/architect-sapfir");
  expect(pluginData("/Users/x/Desktop/мои проекты/architect", "/Users/x")).toBeUndefined();
});

test("in a git clone everything stays next to the code", () => {
  expect(DATA).toBeUndefined();
  expect(WORK).toBe(ARCH_HOME);
});

// After a plugin update the new version has no node_modules (Claude Code doesn't install them) and the host would hang
// on import. The starter clones them from a previous version with the same package.json and bun.lock, without network.
test("after an update the starter clones dependencies from the previous version, then runs the new host", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "arch-launch-"));
  const cache = join(home, ".claude", "plugins", "cache", "sapfir", "architect");
  const version = (v: string, deps: boolean) => {
    const dir = join(cache, v);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    writeFileSync(join(dir, "bun.lock"), "lock-1");
    writeFileSync(join(dir, "src", "main.ts"), `console.log("хост ${v}", process.env.ARCH_DATA);`);
    if (deps) mkdirSync(join(dir, "node_modules", "grammy"), { recursive: true }), writeFileSync(join(dir, "node_modules", "grammy", "mark"), "старая");
    return dir;
  };
  version("aaaaaaaaaaaa", true);
  const fresh = version("bbbbbbbbbbbb", false);
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "architect@sapfir": [{ installPath: fresh }] } }));
  const data = join(home, ".claude", "plugins", "data", "architect-sapfir");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "launch.ts"), readFileSync(join(import.meta.dir, "..", "src", "launch.ts")));
  const p = Bun.spawnSync([process.execPath, join(data, "launch.ts")], { env: { ...process.env, HOME: home, ARCH_DATA: "" }, stdout: "pipe", stderr: "pipe" });
  expect(p.stdout.toString()).toContain("хост bbbbbbbbbbbb");
  expect(readFileSync(join(fresh, "node_modules", "grammy", "mark"), "utf8")).toBe("старая");
  expect(p.stderr.toString()).not.toContain("ставлю зависимости"); // no bun install, no network
  expect(existsSync(join(cache, "aaaaaaaaaaaa", "node_modules"))).toBe(true); // the previous version keeps its copy
});
