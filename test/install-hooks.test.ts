// The shared hook installer adds exactly its own entries, leaves the rest alone and uninstalls cleanly.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arch-inst-"));
process.env.ARCH_STATE_DIR = dir;
process.env.ARCH_LOGS_DIR = dir;
process.env.ARCH_USER_SETTINGS = join(dir, "settings.json");
const original = {
  model: "opus",
  permissions: { defaultMode: "auto", allow: ["Bash(ls:*)"] },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo чужой-хук" }] }] },
  enabledPlugins: { "telegram@claude-plugins-official": false },
};
writeFileSync(process.env.ARCH_USER_SETTINGS, JSON.stringify(original, null, 2) + "\n");
const { install, uninstall, installed } = await import("../src/install-hooks");
const read = () => JSON.parse(readFileSync(process.env.ARCH_USER_SETTINGS!, "utf8"));

test("adds three entries and leaves the rest alone", () => {
  install();
  const s = read();
  expect(installed()).toBe(true);
  expect(s.model).toBe("opus");
  expect(s.permissions).toEqual(original.permissions);
  expect(s.enabledPlugins).toEqual(original.enabledPlugins);
  expect(s.hooks.Stop.length).toBe(2);
  expect(s.hooks.Stop[0].hooks[0].command).toBe("echo чужой-хук");
  expect(s.hooks.PermissionRequest.length).toBe(1);
  expect(s.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
});

test("installing again adds no duplicates", () => {
  install();
  const s = read();
  expect(s.hooks.Stop.length).toBe(2);
  expect(s.hooks.PermissionRequest.length).toBe(1);
});

test("uninstalling restores the original settings", () => {
  uninstall();
  expect(installed()).toBe(false);
  expect(read()).toEqual(original);
});

// A test run from another checkout must not send its sample questions to the real chat, so the shared hook knows the
// test folder of any checkout
test("the test folder of any Architect checkout is internal; testing and unrelated test folders are not", async () => {
  const { ARCH_HOME, isTestCwd } = await import("../src/config");
  const other = mkdtempSync(join(tmpdir(), "arch-copy-"));
  mkdirSync(join(other, "src"), { recursive: true });
  writeFileSync(join(other, "src", "anyhook.ts"), "");
  expect(isTestCwd(join(ARCH_HOME, "test"))).toBe(true);
  expect(isTestCwd(join(other, "test", "case"))).toBe(true);
  expect(isTestCwd(join(ARCH_HOME, "testing"))).toBe(false);
  expect(isTestCwd(join(tmpdir(), "handbook", "test"))).toBe(false);
});

// config.json in the repo is the template; a Mac's own settings go in config.local.json
test("local settings override the template; setup runs on a new install", async () => {
  const { mergeConfig } = await import("../src/config");
  const template = { lang: "en", hookPort: 47300, setupDone: false };
  expect(mergeConfig(template)).toEqual(template); // a new install: setup
  expect(mergeConfig(template, { lang: "ru" })).toEqual({ ...template, lang: "ru" }); // a new install with a language set: setup still
  expect(mergeConfig(template, { lang: "ru", sites: [{ name: "Маяк" }] }, false)).toEqual({ lang: "ru", hookPort: 47300, sites: [{ name: "Маяк" }] }); // in use before setup existed: no setup
  expect(mergeConfig(template, { setupDone: true })).toEqual({ lang: "en", hookPort: 47300, setupDone: true }); // setup done
});
