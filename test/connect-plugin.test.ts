// Подключение без терминала (/architect:connect в сессии Claude Code): QR — картинкой, ссылку и код показывает Claude,
// «да» — его вопросом с кнопками (archi connect --yes кладёт ответ в state/connect.answer). Ящик и Telegram — подставные.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxId, managerKey, newManagerKey, postBox, seal } from "../src/box";
import { config } from "../src/config";
import { MockRelay } from "./mock-relay";

const relay = new MockRelay(tmpdir());
const telegram = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, result: { id: 7, username: "olga_arch_bot" } }) });
afterAll(() => (relay.stop(), telegram.stop(true)));
const TOKEN = "7:AAHtest-token-of-the-personal-bot-0123456789";

async function connect(answer: "yes" | "no") {
  const state = mkdtempSync(join(tmpdir(), "arch-connect-"));
  const mgr = await managerKey(await newManagerKey());
  const p = Bun.spawn([process.execPath, "src/connect.ts", "sapfirarchitect_bot", mgr.pub, relay.url], {
    env: { ...process.env, ARCH_STATE_DIR: state, ARCH_TG_API: `http://127.0.0.1:${telegram.port}`, ARCH_CONFIG: join(import.meta.dir, "config.json") },
    stdin: "ignore", // как в Bash-инструменте Claude Code: терминала нет
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const reader = p.stdout.getReader();
  const until = async (re: RegExp) => {
    while (!re.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`коннектор вышел, не дойдя до ${re}:\n${out}\n${await new Response(p.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    return out.match(re);
  };
  const pub = (await until(/start=c([\w-]{43})/))![1];
  const letter = { v: 1 as const, token: TOKEN, bot: { id: 7, username: "olga_arch_bot" }, owner: { id: 42, name: "Ольга Т" }, manager: "sapfirarchitect_bot", at: Date.now() };
  await postBox(relay.url, await boxId(pub), await seal(letter, pub, mgr.priv)); // менеджер положил конверт
  await until(/archi connect --yes/);
  writeFileSync(join(state, "connect.answer"), `${answer}\n`); // что делает archi connect --yes | --no
  await until(/Подключено|Отменено/);
  return { code: await p.exited, out, state };
}

test("без терминала: QR картинкой, код и ссылка текстом без цветовых кодов, «да» — отдельной командой", { timeout: 30_000 }, async () => {
  const { code, out, state } = await connect("yes");
  expect(code).toBe(0);
  expect(out).toContain("Код для Telegram: ");
  expect(out).not.toContain("\x1b["); // вывод читает Claude — без кодов цвета
  expect(out).toContain("Telegram: Ольга Т, без @имени, бот @olga_arch_bot.");
  if (process.platform === "darwin") expect(readFileSync(join(state, "connect-qr.svg"), "utf8")).toStartWith("<svg"); // QR рисует CoreImage macOS
  expect(readFileSync(join(state, `${config.keychainService}.secret`), "utf8")).toBe(TOKEN); // в проверках связка ключей — файлом
  expect(JSON.parse(readFileSync(join(state, "owner.json"), "utf8")).id).toBe(42);
  expect(existsSync(join(state, "connect.answer"))).toBe(false); // ответ прочитан и убран
});

test("без терминала: «нет» — к этому Mac ничего не подключено", { timeout: 30_000 }, async () => {
  const { code, out, state } = await connect("no");
  expect(code).toBe(1);
  expect(out).toContain("Отменено");
  expect(existsSync(join(state, `${config.keychainService}.secret`))).toBe(false);
  expect(existsSync(join(state, "owner.json"))).toBe(false);
});
