// The connector links this Mac to Telegram without copying keys around; bin/install.sh and `archi connect` run it.
//   bun src/connect.ts <manager-bot> <manager-key> <box-url>
// 1. This Mac's X25519 key is created here and lives only in this process's memory.
// 2. A QR code links to the manager bot with /start c<Mac public key>, plus a four-digit code to type in Telegram
//    (a link can be forwarded, the code must be seen on this screen). Then the person creates their bot.
// 3. Wait in the box for an envelope: the manager's signature, ciphertext for this Mac's key, freshness (src/box.ts).
// 4. Show whose Telegram and which bot it is, and wait for a yes: no bot lands on the Mac without the user's word.
// 5. The token goes to the Keychain, the owner to state/owner.json; from then on the host talks to Telegram itself.
// Without a terminal (/architect:connect in Claude Code) the QR code opens as an image on the Mac screen, Claude shows
// the link and the code, and the yes arrives as `archi connect --yes`, which writes state/connect.answer.
import { existsSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxId, deviceKeys, open, pairCode, waitBox, type Letter } from "./box";
import { STATE, config, ensureDirs, tr } from "./config";
import { writeSecret } from "./secret";
import { sleep, writeJson } from "./util";

const API_ROOT = process.env.ARCH_TG_API ?? "https://api.telegram.org";
const WAIT_MS = 15 * 60_000;
const TTY = !!process.stdin.isTTY;
const paint = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s); // no colors outside a terminal
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const bold = paint(1);

// QR codes via macOS CoreImage (CIQRCodeGenerator), no third-party libraries: rows of "1"/"0" modules
const QR_JXA = `ObjC.import("CoreImage"); ObjC.import("AppKit");
function run(argv) {
  const f = $.CIFilter.filterWithName("CIQRCodeGenerator");
  f.setValueForKey($(argv[0]).dataUsingEncoding($.NSUTF8StringEncoding), "inputMessage");
  f.setValueForKey($("M"), "inputCorrectionLevel");
  const rep = $.NSBitmapImageRep.alloc.initWithCIImage(f.valueForKey("outputImage"));
  const rows = [];
  for (let y = 0; y < rep.pixelsHigh; y++) { let r = ""; for (let x = 0; x < rep.pixelsWide; x++) r += rep.colorAtXY(x, y).brightnessComponent < 0.5 ? "1" : "0"; rows.push(r); }
  return rows.join("\\n");
}`;

function qrMatrix(text: string): string[] {
  let raw: string[] = [];
  try {
    const p = Bun.spawnSync(["osascript", "-l", "JavaScript", "-e", QR_JXA, text], { stdout: "pipe", stderr: "ignore" });
    raw = p.exitCode === 0 ? p.stdout.toString().trim().split("\n") : [];
  } catch {} // no osascript (tests on Linux): no QR, the link and the code matter more
  return raw.length < 21 ? [] : raw;
}

// The QR code as an image, for connecting without a terminal: it opens on the Mac screen for the iPhone camera.
// 4-module quiet zone.
export function qrSvg(text: string): string | undefined {
  const raw = qrMatrix(text);
  if (!raw.length) return;
  const n = raw.length + 8;
  const cells = raw.flatMap((r, y) => [...r].map((c, x) => (c === "1" ? `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>` : ""))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 10}" height="${n * 10}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
}

// Two module rows per terminal line (half blocks), black on white in any Terminal theme; 2-module quiet zone
export function qrLines(text: string): string[] {
  const raw = qrMatrix(text);
  if (!raw.length) return [];
  const w = raw[0].length + 2;
  const m = ["0".repeat(w), ...raw.map((r) => `0${r}0`), "0".repeat(w), "0".repeat(w)];
  const out: string[] = [];
  for (let y = 0; y + 1 < m.length; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) line += { "11": "█", "10": "▀", "01": "▄", "00": " " }[m[y][x] + m[y + 1][x]];
    out.push(`  \x1b[30;107m${line}\x1b[0m`);
  }
  return out;
}

// Account names are chosen by their owners: strip control and bidi characters, so a name can't rewrite the screen
export const plain = (s = "") => s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 64);

// Keyboard input with a plain blocking read (async terminal reads in Bun on macOS fail: kqueue and /dev/tty). Empty
// lines are skipped, so an Enter pressed while waiting for Telegram is no answer. End of input means no.
function answer(): string {
  const buf = Buffer.alloc(256);
  let acc = "";
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch {
      return "";
    }
    if (n === 0) return "";
    acc += buf.toString("utf8", 0, n);
    for (let i = acc.indexOf("\n"); i >= 0; i = acc.indexOf("\n")) {
      const line = acc.slice(0, i).trim();
      acc = acc.slice(i + 1);
      if (line) return line;
    }
  }
}

const ANSWER = join(STATE, "connect.answer");

async function confirm(l: Letter): Promise<boolean> {
  const who = `${plain(l.owner.name)}, ${l.owner.username ? `@${plain(l.owner.username)}` : tr("без @имени", "no @username")}`;
  console.log(`\nTelegram: ${who}, ${tr("бот", "bot")} @${plain(l.bot.username)}.`);
  if (TTY) {
    process.stdout.write(tr("Подключить этот Mac к этому аккаунту? Напишите «да» и нажмите Enter: ", "Connect this Mac to this account? Type “yes” and press Enter: "));
    return /^(да|д|yes|y)$/i.test(answer());
  }
  // without a terminal the person answers with a button in Claude Code; wait 10 minutes for it
  console.log(tr("Подтвердите: archi connect --yes — подключить, archi connect --no — отменить.", "Confirm: archi connect --yes to connect, archi connect --no to cancel."));
  for (const until = Date.now() + 10 * 60_000; Date.now() < until; await sleep(1000)) {
    if (!existsSync(ANSWER)) continue;
    const a = readFileSync(ANSWER, "utf8").trim();
    rmSync(ANSWER, { force: true });
    return a === "yes";
  }
  return false;
}

if (import.meta.main) {
  const [manager, managerPub, relay] = process.argv.slice(2);
  if (!manager || !managerPub || !relay) {
    console.error(tr("bun src/connect.ts <бот-менеджер> <ключ-менеджера> <адрес-ящика>", "bun src/connect.ts <manager-bot> <manager-key> <box-address>"));
    process.exit(2);
  }
  ensureDirs();
  const dev = await deviceKeys();
  const id = await boxId(dev.pub);
  const link = `https://t.me/${manager}?start=c${dev.pub}`;
  rmSync(ANSWER, { force: true }); // a leftover answer from an earlier run doesn't count
  const svg = TTY ? undefined : qrSvg(link);
  if (svg) {
    const file = join(STATE, "connect-qr.svg");
    writeFileSync(file, svg);
    if (!process.env.ARCH_STATE_DIR) Bun.spawn(["open", file], { stdout: "ignore", stderr: "ignore" }); // tests open no windows
    console.log(tr("QR-код открыт на экране Mac: наведите на него камеру iPhone — откроется Telegram.", "The QR code is open on the Mac screen: point your iPhone camera at it — Telegram will open."));
  }
  const qr = TTY ? qrLines(link) : [];
  console.log(qr.length ? tr("Наведите камеру iPhone на QR-код — откроется Telegram.\n", "Point your iPhone camera at the QR code — Telegram will open.\n") : tr("Откройте ссылку на iPhone — откроется Telegram.\n", "Open the link on your iPhone — Telegram will open.\n"));
  if (qr.length) console.log(qr.join("\n") + "\n");
  console.log(`  ${tr("Код для Telegram", "Code for Telegram")}: ${bold(await pairCode(dev.pub))}\n`);
  console.log(dim(`${qr.length ? tr("Или откройте на этом Mac: ", "Or open on this Mac: ") : ""}${link}`) + "\n");
  console.log(tr("Жду Telegram…", "Waiting for Telegram…"));

  let letter: Letter | undefined;
  let why = ""; // why the last envelope was rejected, shown if time runs out
  const until = Date.now() + WAIT_MS;
  while (!letter && Date.now() < until) {
    const envs = await waitBox(relay, id, 25).catch(async () => (await sleep(3000), []));
    for (const env of envs) {
      try {
        const l = await open(env, dev.priv, dev.pub, managerPub); // throws on foreign or forged envelopes
        if (l.manager === manager) {
          letter = l;
          break;
        }
        why = tr("конверт не от того бота", "the envelope is from another bot");
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
    }
    if (!letter && envs.length) await sleep(2000); // rejected envelopes are still there: don't hammer the server
  }
  if (!letter) {
    const hint = why === "письмо устарело" ? tr(" Похоже, на Mac сбиты дата и время.", " The Mac’s date and time look wrong.") : why ? ` (${why})` : "";
    console.log(red(tr(`\nВремя вышло.${hint} Запустите команду ещё раз — появится новый код.`, `\nTime’s up.${hint} Run the command again to get a new code.`)));
    process.exit(1);
  }
  if (!(await confirm(letter))) {
    console.log(tr("Отменено. К этому Mac ничего не подключено.", "Cancelled. Nothing was connected to this Mac."));
    process.exit(1);
  }
  // check with Telegram itself that the token belongs to this bot
  const me = (await fetch(`${API_ROOT}/bot${letter.token}/getMe`, { signal: AbortSignal.timeout(15_000) })
    .then((r) => r.json())
    .catch(() => ({}))) as { ok?: boolean; result?: { id: number; username: string } };
  if (!me.ok || me.result?.id !== letter.bot.id) {
    console.log(red(tr("Ключ бота не подошёл. Запустите команду ещё раз.", "The bot key didn’t work. Run the command again.")));
    process.exit(1);
  }
  writeSecret(config.keychainService, letter.token);
  writeJson(join(STATE, "owner.json"), { id: letter.owner.id, name: letter.owner.name.split(" ")[0], pairedAt: new Date().toISOString(), via: "connect" });
  writeJson(join(STATE, "bot.json"), { username: letter.bot.username });
  console.log(green(tr("Подключено.", "Connected.")));
}
