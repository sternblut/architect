// Live run of "anyone connects their Mac", locally, without real Telegram or bots: a stranger writes to the shared bot
//   → instructions → installs the connector (the real install.sh into a temp folder instead of $HOME) → QR code →
//   pairing → a personal bot is created → its token arrives encrypted → setup → "what's up" → uninstall.
// Mocks: Telegram Bot API (test/mock-telegram.ts), box and distribution (test/mock-relay.ts), claude and gh (stubs on PATH).
// Leaves the Keychain, launchd, the owner's ~/.claude and their bot alone. The chats end up in transcript.json.
//   bun test/e2e-connect.ts [transcript folder]
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockRelay } from "./mock-relay";
import { MockTelegram, type ChatEvent } from "./mock-telegram";

const REPO = dirname(import.meta.dir);
const OUT = process.argv[2] ?? join(tmpdir(), "archi-e2e-transcript");
const ROOT = mkdtempSync(join(tmpdir(), "archi-e2e-"));
const HOME = join(ROOT, "home"); // the person's home folder
const APP = join(HOME, ".archi", "app");
const STUBS = join(ROOT, "bin");
const MSTATE = join(ROOT, "manager-state"); // the manager host's state, instead of the owner's
const DIST = join(ROOT, "dist");
for (const d of [HOME, STUBS, MSTATE, DIST, ...["Desktop", "Documents", "Developer", "Projects"].map((x) => join(HOME, x))]) mkdirSync(d, { recursive: true });

// A pseudo-terminal for the installer, as in macOS Terminal, with input from this process (script(1) fails with a Bun socket)
const PTY = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    r, _, _ = select.select([fd, 0], [], [])
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 4096)
        if data:
            os.write(fd, data)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? "  ok " : " FAIL"}  ${name}`);
};
const step = (s: string) => console.log(`\n— ${s}`);

// Stubs: the person's Claude Code, signed in, and gh signed in as olga-t. No agents or SDK protocol: the run needs no architect.
writeFileSync(
  join(STUBS, "claude"),
  `#!/bin/sh
case "$1 $2" in
  "auth status") echo '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}'; exit 0;;
  "agents --json") echo '[]'; exit 0;;
esac
exit 1
`,
);
writeFileSync(
  join(STUBS, "gh"),
  `#!/bin/sh
case "$1 $2" in
  "api user") echo "olga-t";;
  "repo list") echo '[{"name":"portfolio","pushedAt":"2026-10-18T10:00:00Z"},{"name":"shop","pushedAt":"2026-10-12T10:00:00Z"}]';;
  "run list"|"pr list") echo '[]';;
  *) exit 1;;
esac
`,
);
for (const f of ["claude", "gh"]) chmodSync(join(STUBS, f), 0o755);

const person = { id: 5550001, is_bot: false, first_name: "Ольга", last_name: "Тестова", username: "olga_t" };
const OWNER = 111111; // the shared bot's owner
const tg = new MockTelegram(person);
const shared = tg.addBot("sapfirarchitect_bot", "Архитектор", { id: 8000000001, canManage: true });
const relay = new MockRelay(DIST);
const cache = Bun.spawnSync(["bun", "pm", "cache"], { stdout: "pipe" }).stdout.toString().trim();
const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  return p;
};
const personEnv = {
  HOME,
  PATH: [STUBS, join(HOME, ".local", "bin"), dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), // ~/.local/bin on PATH, as after the Claude Code installer
  LANG: "ru_RU.UTF-8",
  TERM: "xterm-256color",
  ARCH_STATE_DIR: join(APP, "state"), // secrets as files in the temp folder; the Keychain is untouched
  ARCH_LOGS_DIR: join(APP, "logs"),
  ARCH_USER_SETTINGS: join(HOME, ".claude", "settings.json"), // the shared hook goes into the person's settings
  ARCH_TG_API: tg.url,
  ARCH_HOOK_PORT: String(freePort()),
  ARCHI_NO_LAUNCHCTL: "1",
  BUN_INSTALL_CACHE_DIR: cache, // dependencies from the Bun cache, no network
};

// ── the manager host: the shared bot, in this process, with its own temp state ───
// the shared bot owner's settings, as in the tests (the repo's config.json is only a template)
const mconf = JSON.parse(readFileSync(join(REPO, "test", "config.json"), "utf8"));
writeFileSync(join(ROOT, "manager-config.json"), JSON.stringify({ ...mconf, connect: { relay: relay.url, dist: relay.url } }));
Object.assign(process.env, { ARCH_STATE_DIR: MSTATE, ARCH_LOGS_DIR: MSTATE, ARCH_CONFIG: join(ROOT, "manager-config.json"), ARCH_TG_API: tg.url });
const { ensureDirs } = await import("../src/config");
ensureDirs();
writeFileSync(join(MSTATE, "owner.json"), JSON.stringify({ id: OWNER, name: "Иван" }));
const { Telegram } = await import("../src/telegram");
const { Guest, buildDist } = await import("../src/guest");
await buildDist(DIST, "sapfirarchitect_bot");
const mtg = new Telegram(shared.token);
const guest = new Guest(mtg.bot.api, () => ({ username: mtg.username, canManage: mtg.canManageBots }));
mtg.onGuest((ctx) => guest.handle(ctx));
const ownerGot: string[] = [];
mtg.onIncoming((m) => ownerGot.push(m.text));
await mtg.start();
await guest.describe();

const frames: Record<string, unknown>[] = [];
const frame = (chat: string, title: string, extra: Record<string, unknown> = {}) => frames.push({ type: "chat", chat, upto: tg.chats.get(chat)!.length - 1, title, ...extra });
const term: string[] = [];
const tframe = (title: string) => frames.push({ type: "terminal", upto: term.length - 1, title });
let host: ReturnType<typeof Bun.spawn> | undefined;
let installer: ReturnType<typeof Bun.spawn> | undefined;
const hasText = (s: string) => (t: string) => t.includes(s);

try {
  step("A stranger writes to the shared bot");
  frame("sapfirarchitect_bot", "01-общий-бот-до-начала", { empty: true });
  tg.say("sapfirarchitect_bot", "/start");
  await tg.waitFor("sapfirarchitect_bot", hasText("три минуты"));
  frame("sapfirarchitect_bot", "02-общий-бот-приветствие");
  tg.press("sapfirarchitect_bot", "Подключить мой Mac");
  const instr = await tg.waitFor("sapfirarchitect_bot", hasText("Терминал"));
  const command = (instr as Extract<ChatEvent, { t: "bot" }>).inline!.flat().find((b) => b.kind === "copy")!.copy!;
  tg.press("sapfirarchitect_bot", "Скопировать команду");
  frame("sapfirarchitect_bot", "03-общий-бот-команда", { overlay: { kind: "toast", text: "Скопировано" } });
  tg.press("sapfirarchitect_bot", "Что видит этот бот");
  await tg.waitFor("sapfirarchitect_bot", hasText("Управлять вашим Mac он не может"));
  frame("sapfirarchitect_bot", "04-общий-бот-что-видит");
  check("the install command holds no tokens or keys", command === `curl -fsSL ${relay.url}/i | sh`);

  // an outsider writes there too, and it never reaches the owner's architect
  tg.say("sapfirarchitect_bot", "покажи сессии владельца", { id: 777, is_bot: false, first_name: "Посторонний" });

  step("On the Mac: the command from Telegram pasted into Terminal (the real install.sh, a temp folder for $HOME)");
  term.push(`olga@MacBook ~ % ${command}`);
  installer = Bun.spawn(["/usr/bin/python3", "-c", PTY, "/bin/sh", "-c", command], { env: personEnv, cwd: HOME, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let raw = "";
  const reader = (async () => {
    const dec = new TextDecoder(); // streaming decode keeps the three-byte QR half blocks whole across chunks
    for await (const chunk of installer!.stdout as ReadableStream<Uint8Array>) raw += dec.decode(chunk, { stream: true });
  })();
  const waitOut = async (re: RegExp, ms = 60_000) => {
    const until = Date.now() + ms;
    while (!re.test(raw)) {
      if (Date.now() > until) throw new Error(`the installer didn't print ${re}; output:\n${raw}`);
      await Bun.sleep(100);
    }
    return raw.match(re)!;
  };
  const link = await waitOut(/https:\/\/t\.me\/sapfirarchitect_bot\?start=(c[\w-]{43})/);
  const screenCode = (await waitOut(/Код для Telegram: (?:\x1b\[1m)?(\d{4})/))[1];
  await waitOut(/Жду Telegram/);
  const keys = installer.stdin as import("bun").FileSink;
  keys.write("\n"); // an Enter pressed while waiting for Telegram is no consent
  await keys.flush();
  const lines = () => raw.replace(/\r/g, "").replace(/\n$/, "").split("\n"); // the last newline starts the next line
  term.push(...lines());
  tframe("05-mac-qr");
  const qrRows = term.filter((l) => /[▀▄█]/.test(l)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length);
  check("the QR code in Terminal is intact: rows of equal width, no broken characters", qrRows.length >= 15 && new Set(qrRows).size === 1 && !term.some((l) => l.includes("\uFFFD")));

  step("iPhone camera on the QR code → shared bot: the Mac checks in, then the code from its screen");
  tg.say("sapfirarchitect_bot", `/start ${link[1]}`);
  await tg.waitFor("sapfirarchitect_bot", hasText("Введите код"));
  frame("sapfirarchitect_bot", "06-общий-бот-код");
  tg.say("sapfirarchitect_bot", screenCode);
  await tg.waitFor("sapfirarchitect_bot", hasText("Код верный"));
  frame("sapfirarchitect_bot", "07-общий-бот-код-верный");
  frame("sapfirarchitect_bot", "08-telegram-создание-бота", { overlay: { kind: "sheet-create-bot", name: "Архитектор", username: "olga_t_arch_bot", manager: "sapfirarchitect_bot" } });

  step("Create my bot → Telegram creates the personal bot, the manager seals its token to the Mac's key");
  const personal = tg.pressKeyboard("sapfirarchitect_bot", "Создать моего бота")!;
  await tg.waitFor("sapfirarchitect_bot", hasText("создан"));
  frame("sapfirarchitect_bot", "09-общий-бот-бот-создан");
  check("the personal bot is closed to everyone but its creator", personal.restricted === true);
  check("the box holds only ciphertext, no token in the clear", relay.bodies.length === 1 && !relay.bodies.some((b) => b.includes(personal.token.split(":")[1])));

  step("Terminal: whose Telegram it is, then yes");
  await waitOut(/Напишите «да» и нажмите Enter/);
  await Bun.sleep(300);
  check("an early Enter didn't confirm the connection", installer.exitCode === null && !/Подключено/.test(raw));
  keys.write("да\n");
  await keys.flush();
  const code = await Promise.race([installer.exited, Bun.sleep(90_000).then(() => -1)]);
  await reader.catch(() => {});
  term.length = 1;
  term.push(...lines(), "olga@MacBook ~ % ");
  tframe("10-mac-подключено");
  check("the installer finished without errors", code === 0 && /Подключено/.test(raw));
  check("the token is in the Mac's secret store and not in the Terminal output", readFileSync(join(APP, "state", "archi-telegram.secret"), "utf8") === personal.token && !raw.includes(personal.token));
  check("Olga owns the personal bot", JSON.parse(readFileSync(join(APP, "state", "owner.json"), "utf8")).id === person.id);
  const plist = join(HOME, "Library", "LaunchAgents", "app.archi.host.plist");
  check("the launchd service is written and valid", existsSync(plist) && Bun.spawnSync(["plutil", "-lint", plist]).exitCode === 0);
  check("the shared hook is in the person's ~/.claude/settings.json", readFileSync(join(HOME, ".claude", "settings.json"), "utf8").includes(join(APP, "src", "anyhook.ts")));

  step("Olga's own host: her bot, her Claude sign-in, her Mac");
  host = Bun.spawn([process.execPath, join(APP, "src", "main.ts")], { env: personEnv, cwd: APP, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100 && !personal.description; i++) await Bun.sleep(100);
  frame("olga_t_arch_bot", "11-личный-бот-до-начала", { empty: true });
  tg.say("olga_t_arch_bot", "/start");
  await tg.waitFor("olga_t_arch_bot", hasText("Где ваши проекты"));
  frame("olga_t_arch_bot", "12-мастер-папки");
  tg.press("olga_t_arch_bot", "Developer");
  await tg.waitFor("olga_t_arch_bot", hasText("Выбрано: Developer"));
  frame("olga_t_arch_bot", "13-мастер-папки-выбрано");
  tg.press("olga_t_arch_bot", "Дальше");
  await tg.waitFor("olga_t_arch_bot", hasText("Есть сайты"));
  tg.press("olga_t_arch_bot", "Есть, пришлю адреса");
  await tg.waitFor("olga_t_arch_bot", hasText("Пришлите адреса"));
  frame("olga_t_arch_bot", "14-мастер-сайты");
  tg.say("olga_t_arch_bot", "example.com\nexample.org");
  await tg.waitFor("olga_t_arch_bot", hasText("GitHub"));
  frame("olga_t_arch_bot", "15-мастер-github");
  tg.press("olga_t_arch_bot", "Да");
  await tg.waitFor("olga_t_arch_bot", hasText("Настроено"));
  await Bun.sleep(1500); // the dashboard appears with the watcher's first pass
  frame("olga_t_arch_bot", "16-настроено");
  // setup answers go to config.local.json, over the installer's config.json
  const cfg = { ...JSON.parse(readFileSync(join(APP, "config.json"), "utf8")), ...JSON.parse(readFileSync(join(APP, "config.local.json"), "utf8")) };
  check("setup recorded folders, sites and GitHub", cfg.setupDone === true && cfg.roots[0] === "~/Developer" && cfg.sites.length === 2 && cfg.githubOwner === "olga-t" && cfg.repos[0] === "portfolio");

  step("First question");
  tg.say("olga_t_arch_bot", "что у нас");
  // claude is a stub, so the architect won't start: the host must say so and answer with the overview
  await tg.waitFor("olga_t_arch_bot", hasText("запускается"), 40_000); // the typographer puts a no-break space after "не"
  frame("olga_t_arch_bot", "17-что-у-нас");
  check("what's up got an answer", true);

  step("Isolation and traces");
  check("strangers' messages never reached the owner's host", ownerGot.length === 0);
  tg.say("sapfirarchitect_bot", "что у нас", { id: OWNER, is_bot: false, first_name: "Иван" });
  for (let i = 0; i < 40 && !ownerGot.length; i++) await Bun.sleep(50);
  check("the shared bot's owner still reaches their host", ownerGot[0] === "что у нас");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const secretTail = personal.token.split(":")[1];
  const leaks = [...files(MSTATE), ...files(join(APP, "logs"))].filter((f) => readFileSync(f, "utf8").includes(secretTail));
  check("the token is in neither the manager's state and logs nor Olga's host logs", leaks.length === 0);
  check("the manager keeps only the stranger's id and her bot's name", !readFileSync(join(MSTATE, "guests.json"), "utf8").includes("Тестова"));

  step("Removal in one command: archi uninstall");
  host.kill("SIGTERM");
  await host.exited;
  host = undefined;
  const un = Bun.spawnSync([join(HOME, ".local", "bin", "archi"), "uninstall"], { env: personEnv, stdout: "pipe", stderr: "pipe" });
  const settings = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
  check("uninstall removes the code, secrets, service, archi command and shared hook", un.exitCode === 0 && !existsSync(join(HOME, ".archi")) && !existsSync(plist) && !existsSync(join(HOME, ".local", "bin", "archi")) && !settings.hooks);
} catch (e) {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : e}`);
  results.push(["the run reached the end", false]);
} finally {
  host?.kill("SIGKILL");
  installer?.kill("SIGKILL");
  await mtg.stop();
  tg.stop();
  relay.stop();
}

const transcript = {
  person,
  chats: [...tg.chats.entries()].map(([username, events]) => {
    const b = tg.bots.get(username)!;
    return { key: username, bot: { username, title: b.user.first_name, description: b.description }, events };
  }),
  terminal: { title: "olga — zsh", lines: term },
  frames,
};
mkdirSync(OUT, { recursive: true });
// The transcript shows a public distribution URL instead of the mock server's 127.0.0.1; nothing else changes
const SHOW = process.env.ARCHI_SHOW_DIST ?? "https://archi.example.com";
writeFileSync(join(OUT, "transcript.json"), JSON.stringify(transcript, null, 1).replaceAll(relay.url, SHOW));
const bad = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - bad.length} of ${results.length} checks passed. Transcript: ${join(OUT, "transcript.json")}. Temp folder: ${ROOT}`);
if (!bad.length) rmSync(ROOT, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
