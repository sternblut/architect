// The cloud relay for while the Mac sleeps (a Worker, relay/). Going to sleep, the host stops polling Telegram and
// points a webhook at the Worker under a new random path; on wake it removes the webhook, takes the queue, feeds it to
// grammY and polls again. The cloud holds no secrets: the path lives only in the host's memory and in Telegram (the
// Worker keeps its SHA-256), and requests to the Worker are signed with this Mac's Ed25519 key from the Keychain.
// src/powerwatch.swift reports sleep and wake.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { STATE, config } from "./config";
import type { Telegram } from "./telegram";
import { clip, log, registerSecret, run, scrub, since, sleep } from "./util";

export const KEY_SERVICE = `${config.keychainService}-relay`;
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const sha256 = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
type Signal = Parameters<Telegram["bot"]["api"]["setWebhook"]>[2];
const within = (ms: number) => AbortSignal.timeout(ms) as unknown as Signal; // grammY has its own AbortSignal type

type Mode = "awake" | "asleep";

export class Relay {
  private want: Mode = "awake"; // the last mode asked for
  private began: Mode = "awake"; // the last mode started (polling runs from host start)
  private handed = false; // the webhook points to the relay
  private chain: Promise<unknown> = Promise.resolve();
  private lastTs = 0;
  askedSleepAt = 0;

  constructor(private d: { tg: Telegram; url: string; key: CryptoKey; summary: () => string | undefined }) {}

  get asleep() {
    return this.want === "asleep";
  }

  sleep() {
    return this.go("asleep");
  }

  wake() {
    return this.go("awake");
  }

  // Sleep and wake run in order, skipping a request that was already reversed. A failed handoff (no network) is
  // retried at the next sleep.
  private go(w: Mode) {
    this.want = w;
    if (w === "asleep") this.askedSleepAt = Date.now();
    return (this.chain = this.chain
      .then(() => {
        if (this.want !== w || (w === "asleep" ? this.handed : this.began === "awake")) return;
        return w === "asleep" ? this.handoff() : this.takeBack();
      })
      .catch((e) => log("relay", w === "asleep" ? "бот не передан дежурному" : "бот не вернулся на Mac", String(e))));
  }

  // Going to sleep: stop polling (received updates are confirmed, new ones wait in Telegram) → the Worker gets the new
  // path's hash and the summary → webhook
  private async handoff() {
    const owner = this.d.tg.owner;
    if (!owner) return; // not paired: nobody for the relay to answer
    this.began = "asleep";
    const t = Date.now();
    await Promise.race([this.d.tg.stop(), sleep(4000)]);
    const path = b64u(crypto.getRandomValues(new Uint8Array(32))); // never logged; grammY errors don't include the URL
    await this.signed("/sleep", { pathHash: await sha256(path), owner, since: since(Date.now()), summary: this.summary(), lang: config.lang ?? "ru" });
    await this.d.tg.bot.api.setWebhook(`${this.d.url}/u/${path}`, { allowed_updates: ["message", "callback_query"], max_connections: 1 }, within(6000));
    this.handed = true;
    log("relay", `Mac засыпает — бот у дежурного (${Date.now() - t} мс)`);
  }

  // Awake: remove the webhook (or polling gets 409; the network may take a while after sleep) → the queue → polling
  private async takeBack() {
    this.began = "awake";
    this.handed = false;
    const t = Date.now();
    for (let tries = 0; this.want === "awake"; tries++) {
      try {
        await this.d.tg.bot.api.deleteWebhook({ drop_pending_updates: false }, within(10_000));
        break;
      } catch (e) {
        if (!tries) log("relay", "webhook не снят — повторяю каждые 3 с", String(e));
        await sleep(3000);
      }
    }
    if (this.want !== "awake") return;
    await this.drain();
    if (this.want !== "awake") return; // the Mac went back to sleep meanwhile
    this.d.tg.poll();
    log("relay", `Mac проснулся — бот снова на Mac (${Date.now() - t} мс)`);
  }

  // The relay's queue goes through normal grammY handling (update_id receipts prevent doubles). Only the message is
  // taken and the update is rebuilt, so a button tap planted next to it never reaches the handlers. Marked relayed,
  // a "yes <id>" can't become a decision.
  async drain() {
    let ack = 0;
    try {
      await this.d.tg.bot.init();
      while (this.want === "awake") {
        const { updates } = (await this.signed("/pull", { ack })) as { updates: Update[] };
        if (!updates.length) return;
        for (const u of updates) {
          if (typeof u?.update_id !== "number") continue;
          ack = u.update_id;
          const m = u.message;
          if (!m || typeof m !== "object") {
            log("relay", "из облака пришло не сообщение — отброшено", { id: u.update_id });
            continue;
          }
          this.d.tg.relayed.add(m);
          await this.d.tg.bot.handleUpdate({ update_id: u.update_id, message: m }).catch((e) => log("relay", "сообщение из облака не обработано", String(e)));
        }
      }
    } catch (e) {
      log("relay", "очередь из облака не забрал — повторю через минуту", String(e));
      setTimeout(() => {
        if (this.want === "awake") this.chain = this.chain.then(() => (this.want === "awake" ? this.drain() : undefined));
      }, 60_000);
    }
  }

  // The overview the Worker sends as is during sleep: plain text without markup or emoji. Bold goes before unescaping,
  // so literal asterisks in names stay.
  private summary() {
    const s = this.d.summary();
    if (!s) return undefined;
    const plain = s
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/\\([\\`*_[\]~|<>$=#])/g, "$1")
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]\s?/gu, "")
      .replace(/ +\n/g, "\n");
    return clip(scrub(plain), 3500);
  }

  private async signed(path: string, body: unknown): Promise<unknown> {
    const ts = (this.lastTs = Math.max(Date.now(), this.lastTs + 1));
    const text = JSON.stringify(body);
    const sig = await crypto.subtle.sign("Ed25519", this.d.key, new TextEncoder().encode(`${path}\n${ts}\n${text}`));
    const res = await fetch(this.d.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-ts": String(ts), "x-relay-sig": b64u(sig) },
      body: text,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`relay answered ${res.status}`);
    return res.json();
  }
}

// A full wake has graphics (IOPMrootDomain "System Capabilities": 1 CPU, 2 graphics, 4 audio, 8 network). A dark wake
// (Power Nap, lid closed) has none, and the bot stays with the relay.
export async function fullWake(): Promise<boolean> {
  const r = await run(["ioreg", "-r", "-c", "IOPMrootDomain", "-k", "System Capabilities", "-d", "1"], { timeoutMs: 5000 });
  const caps = Number(r.stdout.match(/"System Capabilities" = (\d+)/)?.[1]);
  return !Number.isFinite(caps) || (caps & 2) !== 0; // unknown counts as awake: a deaf bot is worse than an extra handover
}

// The helper prints "sleep N" and waits up to 20 s for "ok N"; "wake" means awake. Safeguard: if the relay has had the
// bot for over a minute while the Mac is awake (the sleep didn't happen or "wake" was lost), take the bot back.
export function watchPower(relay: Relay, cmd: string[]) {
  const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("sleep ")) {
          await relay.sleep();
          p.stdin.write(`ok ${line.slice(6)}\n`);
          p.stdin.flush();
        } else if (line === "wake" && (await fullWake())) void relay.wake();
      }
    }
  })()
    .catch((e) => log("relay", "связь с помощником сна оборвалась", String(e)))
    .finally(() => log("relay", "помощник сна завершился — до перезапуска хоста бот во сне молчит"));
  setInterval(async () => {
    if (relay.asleep && Date.now() - relay.askedSleepAt > 60_000 && (await fullWake())) void relay.wake();
  }, 5000).unref();
  return p;
}

// The helper is built into state/ on first start (swiftc from the Command Line Tools)
async function powerHelper(): Promise<string | undefined> {
  const src = join(import.meta.dir, "powerwatch.swift");
  const bin = join(STATE, "powerwatch");
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
  const r = await run(["swiftc", "-O", src, "-o", bin], { timeoutMs: 300_000 });
  if (r.code === 0) return bin;
  log("relay", "помощник сна не собрался — бот во сне будет молчать", clip(r.stderr, 300));
}

// Runs only with relay.url in the config and this Mac's key in the Keychain (bun src/relay-key.ts). Any failure here is
// only logged, and the host works as it would without the relay.
export async function startRelay(tg: Telegram, summary: () => string | undefined) {
  if (!config.relay?.url) return;
  try {
    const r = await run(["security", "find-generic-password", "-a", config.keychainAccount, "-s", KEY_SERVICE, "-w"], { timeoutMs: 15_000 });
    if (r.code !== 0) return log("relay", "нет ключа Mac для дежурного (bun src/relay-key.ts) — бот во сне будет молчать");
    const pkcs8 = r.stdout.trim();
    registerSecret(pkcs8);
    const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), "Ed25519", false, ["sign"]);
    const relay = new Relay({ tg, url: config.relay.url.replace(/\/+$/, ""), key, summary });
    await relay.drain(); // the host may have died while the relay had the bot: take what piled up
    const bin = await powerHelper();
    if (bin) watchPower(relay, [bin]);
    log("relay", "дежурный в облаке подключён");
  } catch (e) {
    log("relay", "дежурный не подключён — бот во сне будет молчать", String(e));
  }
}
