// Архитектор как плагин Claude Code: код — в папке версии, всё постоянное — в папке данных плагина.
import { expect, test } from "bun:test";
import { DATA, WORK, ARCH_HOME, pluginData } from "../src/config";

test("папка данных плагина — по папке его версии, как её называет Claude Code", () => {
  expect(pluginData("/Users/x/.claude/plugins/cache/sapfir/architect/0f3c2a1b9e7d", "/Users/x")).toBe("/Users/x/.claude/plugins/data/architect-sapfir");
  expect(pluginData("/Users/x/Desktop/мои проекты/architect", "/Users/x")).toBeUndefined();
});

test("из git — всё рядом с кодом, как раньше", () => {
  expect(DATA).toBeUndefined();
  expect(WORK).toBe(ARCH_HOME);
});

// после обновления плагина у новой версии нет node_modules (Claude Code их не ставит), и хост виснет на import.
// Стартер берёт их у прежней версии с теми же package.json и bun.lock — клоном APFS, за секунды, без сети.
test("стартер после обновления: зависимости — клоном от прежней версии, потом запуск хоста новой версии", async () => {
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
  expect(p.stderr.toString()).not.toContain("ставлю зависимости"); // без bun install и сети
  expect(existsSync(join(cache, "aaaaaaaaaaaa", "node_modules"))).toBe(true); // у прежней версии ничего не забрали
});
