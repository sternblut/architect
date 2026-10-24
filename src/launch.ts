// Запуск хоста из плагина Claude Code (его вызывает launchd). Код — в папке текущей версии плагина: она меняется с каждым
// обновлением и через 14 дней удаляется, поэтому её ищем при каждом старте — обновление плагина подхватит перезапуск.
// Этот файл лежит в папке данных плагина: его кладёт туда `arch on`. Всё постоянное — рядом с ним.
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
  process.exit(0); // launchd поднимает заново только после сбоя: удалённый плагин не крутится по кругу
}
// Зависимости — свои у каждой версии. При установке их ставит Claude Code, а при обновлении — нет: без node_modules
// хост виснет — Bun ставит пакеты из сети прямо на import. Ставим сами, как официальный плагин Telegram на каждом
// запуске, но только когда их нет.
if (!existsSync(join(root, "node_modules"))) {
  // те же package.json и bun.lock, что у прежней версии, — её node_modules клоном APFS (мгновенно, без лишнего места):
  // bun install шёл почти 4 минуты, и бот молчал бы после каждого обновления
  const same = (dir: string) => ["package.json", "bun.lock"].every((f) => existsSync(join(dir, f)) && readFileSync(join(dir, f), "utf8") === readFileSync(join(root, f), "utf8"));
  const prev = readdirSync(dirname(root))
    .map((v) => join(dirname(root), v))
    .find((dir) => dir !== root && existsSync(join(dir, "node_modules")) && same(dir));
  if (prev) Bun.spawnSync(["cp", process.platform === "darwin" ? "-cR" : "-R", join(prev, "node_modules"), join(root, "node_modules")], { stdout: "inherit", stderr: "inherit" }); // -c — клон APFS
}
if (!existsSync(join(root, "node_modules"))) {
  console.error(`ставлю зависимости версии ${root.split("/").pop()}`);
  const r = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    console.error("зависимости не поставились — хост не запускаю");
    process.exit(1); // launchd попробует снова через 10 секунд
  }
}
process.env.ARCH_DATA ??= import.meta.dir;
await import(join(root, "src", "main.ts"));
