// Установщик общего хука: добавляет ровно свои записи, чужое не трогает, снимается начисто.
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

test("ставит три записи и не трогает чужое", () => {
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

test("повторная установка не плодит дубли", () => {
  install();
  const s = read();
  expect(s.hooks.Stop.length).toBe(2);
  expect(s.hooks.PermissionRequest.length).toBe(1);
});

test("снятие возвращает настройки к исходным", () => {
  uninstall();
  expect(installed()).toBe(false);
  expect(read()).toEqual(original);
});

// проверка из другой копии кода не должна слать владельцу в настоящий чат пробные «Удалить файлы…?» и «Какой вариант?»:
// общий хук узнаёт папку проверок любой копии, а не только своей
test("папка проверок любой копии архитектора — служебная; «testing» и чужие test — нет", async () => {
  const { ARCH_HOME, isTestCwd } = await import("../src/config");
  const other = mkdtempSync(join(tmpdir(), "arch-copy-"));
  mkdirSync(join(other, "src"), { recursive: true });
  writeFileSync(join(other, "src", "anyhook.ts"), "");
  expect(isTestCwd(join(ARCH_HOME, "test"))).toBe(true);
  expect(isTestCwd(join(other, "test", "case"))).toBe(true);
  expect(isTestCwd(join(ARCH_HOME, "testing"))).toBe(false);
  expect(isTestCwd(join(tmpdir(), "handbook", "test"))).toBe(false);
});

// config.json в репозитории — образец, свои настройки Mac — в config.local.json
test("свои настройки поверх образца; мастер — только пока своих нет", async () => {
  const { mergeConfig } = await import("../src/config");
  const template = { lang: "en", hookPort: 47300, setupDone: false };
  expect(mergeConfig(template)).toEqual(template); // новая установка — мастер настройки
  expect(mergeConfig(template, { lang: "ru", sites: [{ name: "Маяк" }] })).toEqual({ lang: "ru", hookPort: 47300, sites: [{ name: "Маяк" }] }); // своё — без мастера
  expect(mergeConfig(template, { setupDone: true })).toEqual({ lang: "en", hookPort: 47300, setupDone: true }); // мастер пройден
});
