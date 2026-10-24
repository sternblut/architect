// Дежурный в облаке, пока Mac спит (Worker — relay/). Засыпая, хост останавливает опрос Telegram и ставит webhook на Worker
// по новому случайному пути; проснувшись — снимает webhook, забирает очередь, отдаёт её grammY и снова опрашивает сам.
// Секретов в облаке нет: путь живёт только в памяти хоста и в Telegram (у Worker — его SHA-256), запросы к Worker
// подписаны ключом Mac (Ed25519, закрытый — в связке ключей). О сне и пробуждении говорит помощник src/powerwatch.swift.
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
const within = (ms: number) => AbortSignal.timeout(ms) as unknown as Signal; // у grammY свой тип AbortSignal (abort-controller)

type Mode = "awake" | "asleep";

export class Relay {
  private want: Mode = "awake"; // чего просили последним
  private began: Mode = "awake"; // что начали делать последним (опрос идёт с запуска хоста)
  private handed = false; // webhook на дежурного поставлен
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

  // Сон и пробуждение — по очереди; устаревшее (уже попросили обратное) не выполняется.
  // Неудавшаяся передача (нет сети) повторяется на следующем «засыпаю».
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

  // Засыпаю: опрос стоп (принятое подтверждается, новое ждёт в Telegram) → Worker получает хеш нового пути и сводку → webhook.
  private async handoff() {
    const owner = this.d.tg.owner;
    if (!owner) return; // не сопряжён — дежурному некому отвечать, бот спит вместе с Mac, как раньше
    this.began = "asleep";
    const t = Date.now();
    await Promise.race([this.d.tg.stop(), sleep(4000)]);
    const path = b64u(crypto.getRandomValues(new Uint8Array(32))); // в журнал не пишется нигде: ошибки grammY адрес не содержат
    await this.signed("/sleep", { pathHash: await sha256(path), owner, since: since(Date.now()), summary: this.summary() });
    await this.d.tg.bot.api.setWebhook(`${this.d.url}/u/${path}`, { allowed_updates: ["message", "callback_query"], max_connections: 1 }, within(6000));
    this.handed = true;
    log("relay", `Mac засыпает — бот у дежурного (${Date.now() - t} мс)`);
  }

  // Проснулся: webhook снять (иначе опрос получит 409; сеть после сна поднимается не сразу) → очередь → снова опрос.
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
    if (this.want !== "awake") return; // пока забирали очередь, Mac снова засыпает — опрос не начинать
    this.d.tg.poll();
    log("relay", `Mac проснулся — бот снова на Mac (${Date.now() - t} мс)`);
  }

  // Очередь из облака — в обычную обработку grammY (квитанции update_id не дадут обработать дважды).
  // Из облака берётся только сообщение — и только оно: апдейт пересобирается заново, так что нажатие кнопки,
  // подложенное рядом с сообщением, до обработчиков не дойдёт. Пометка relayed: «да код» решением не станет.
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

  // Сводка для «что у нас» во сне: обычный текст без разметки и значков — Worker шлёт её как есть.
  // Жирное снимается до экранирования: звёздочки в именах папок («каталог****») остаются звёздочками.
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
    if (!res.ok) throw new Error(`дежурный ответил ${res.status}`);
    return res.json();
  }
}

// Полное пробуждение — с графикой (IOPMrootDomain «System Capabilities»: 1 процессор, 2 графика, 4 звук, 8 сеть).
// Тёмное пробуждение (Power Nap, крышка закрыта) — без графики: бот остаётся у дежурного.
export async function fullWake(): Promise<boolean> {
  const r = await run(["ioreg", "-r", "-c", "IOPMrootDomain", "-k", "System Capabilities", "-d", "1"], { timeoutMs: 5000 });
  const caps = Number(r.stdout.match(/"System Capabilities" = (\d+)/)?.[1]);
  return !Number.isFinite(caps) || (caps & 2) !== 0; // не узнали — считаем, что проснулся: глухой бот хуже лишней передачи
}

// Помощник говорит «sleep N» и ждёт «ok N» (не дольше 20 с), «wake» — проснулся. Страховка: если бот у дежурного
// больше минуты, а Mac бодр (сон не случился или «wake» потерялся) — забрать бота.
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

// Помощник собирается при первом запуске в state/ (swiftc из Command Line Tools).
async function powerHelper(): Promise<string | undefined> {
  const src = join(import.meta.dir, "powerwatch.swift");
  const bin = join(STATE, "powerwatch");
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
  const r = await run(["swiftc", "-O", src, "-o", bin], { timeoutMs: 300_000 });
  if (r.code === 0) return bin;
  log("relay", "помощник сна не собрался — бот во сне будет молчать", clip(r.stderr, 300));
}

// Включается, только если в config.json есть relay.url, а в связке ключей — ключ Mac (bun src/relay-key.ts).
// Любой сбой здесь — только запись в журнал: хост работает как без дежурного.
export async function startRelay(tg: Telegram, summary: () => string | undefined) {
  if (!config.relay?.url) return;
  try {
    const r = await run(["security", "find-generic-password", "-a", config.keychainAccount, "-s", KEY_SERVICE, "-w"], { timeoutMs: 15_000 });
    if (r.code !== 0) return log("relay", "нет ключа Mac для дежурного (bun src/relay-key.ts) — бот во сне будет молчать");
    const pkcs8 = r.stdout.trim();
    registerSecret(pkcs8);
    const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), "Ed25519", false, ["sign"]);
    const relay = new Relay({ tg, url: config.relay.url.replace(/\/+$/, ""), key, summary });
    await relay.drain(); // хост мог упасть, пока бот был у дежурного: забрать, что накопилось
    const bin = await powerHelper();
    if (bin) watchPower(relay, [bin]);
    log("relay", "дежурный в облаке подключён");
  } catch (e) {
    log("relay", "дежурный не подключён — бот во сне будет молчать", String(e));
  }
}
