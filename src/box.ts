// Почтовый ящик подключения: токен личного бота едет с Mac менеджера на Mac человека запечатанным конвертом.
// Конверт зашифрован на открытый ключ Mac человека и подписан ключом менеджера; сервер-ящик видит только шифр.
// Схема — как у запечатанных конвертов age и libsodium: одноразовый ключ X25519 + HKDF-SHA256 + AES-256-GCM, подпись Ed25519.
// Только WebCrypto. Протокол ящика — test/mock-relay.ts (образец) и relay/src/index.ts.

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = crypto.subtle;
const V = "archi-box-v1";
const FRESH_MS = 15 * 60_000; // конверт старше 15 минут не принимается

export const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");
export const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const pair = (alg: "X25519" | "Ed25519", uses: ("deriveBits" | "sign" | "verify")[]) => subtle.generateKey({ name: alg }, true, uses) as unknown as Promise<CryptoKeyPair>;
const x25519 = (pub: CryptoKey, priv: CryptoKey) => subtle.deriveBits({ name: "X25519", public: pub } as never, priv, 256);
const isKey = (s: unknown, bytes: number) => typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s) && unb64u(s).length === bytes;

// Конверт на проводе: всё — base64url.
export type Envelope = { v: 1; eph: string; iv: string; ct: string; sig: string };
// Письмо внутри конверта.
export type Letter = {
  v: 1;
  token: string;
  bot: { id: number; username: string; name?: string };
  owner: { id: number; name: string; username?: string };
  manager: string;
  at: number;
};

// Ключ Mac человека: живёт только в памяти процесса подключения; наружу — открытая часть, 43 знака (влезает в ссылку /start).
export async function deviceKeys(): Promise<{ pub: string; priv: CryptoKey }> {
  const k = await pair("X25519", ["deriveBits"]);
  return { pub: b64u(await subtle.exportKey("raw", k.publicKey)), priv: k.privateKey };
}

export const isDevicePub = (s: unknown): s is string => isKey(s, 32);

// Имя ящика выводится из ключа Mac: сервер не знает ни ключа, ни владельца ящика.
export async function boxId(devicePub: string): Promise<string> {
  return b64u(await subtle.digest("SHA-256", te.encode(`${V}:${devicePub}`))).slice(0, 32);
}

// Код сверки: четыре цифры из ключа Mac. Mac печатает их рядом с QR, человек вводит в Telegram.
// Ссылку из чужого Терминала можно переслать кому угодно, а код с экрана своего Mac — только увидеть.
export async function pairCode(devicePub: string): Promise<string> {
  const h = new Uint8Array(await subtle.digest("SHA-256", te.encode(`archi-code-v1:${devicePub}`)));
  return String(((h[0] << 16) | (h[1] << 8) | h[2]) % 10_000).padStart(4, "0");
}

// Ключ менеджера (подпись конвертов): хранится как PKCS#8 в base64url, открытая часть — 43 знака.
export async function newManagerKey(): Promise<string> {
  const k = await pair("Ed25519", ["sign", "verify"]);
  return b64u(await subtle.exportKey("pkcs8", k.privateKey));
}

export async function managerKey(pkcs8: string): Promise<{ priv: CryptoKey; pub: string }> {
  const priv = await subtle.importKey("pkcs8", unb64u(pkcs8), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await subtle.exportKey("jwk", priv);
  return { priv, pub: jwk.x! };
}

async function aesKey(shared: ArrayBuffer, ephPub: Uint8Array, devPub: Uint8Array) {
  const s = new Uint8Array(shared);
  if (s.every((x) => x === 0)) throw new Error("плохой ключ"); // точка малого порядка — общий секрет нулевой
  const ikm = await subtle.importKey("raw", s, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array([...ephPub, ...devPub]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(V) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const signed = (id: string, e: Pick<Envelope, "eph" | "iv" | "ct">) => te.encode(`${V}:${id}.${e.eph}.${e.iv}.${e.ct}`);

export async function seal(letter: Letter, devicePub: string, signer: CryptoKey): Promise<Envelope> {
  if (!isDevicePub(devicePub)) throw new Error("ключ Mac не похож на X25519");
  const id = await boxId(devicePub);
  const dev = unb64u(devicePub);
  const eph = await pair("X25519", ["deriveBits"]);
  const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const devKey = await subtle.importKey("raw", dev, { name: "X25519" }, false, []);
  const key = await aesKey(await x25519(devKey, eph.privateKey), ephPub, dev);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${V}:${id}`) }, key, te.encode(JSON.stringify(letter)));
  const body = { eph: b64u(ephPub), iv: b64u(iv), ct: b64u(ct) };
  return { v: 1, ...body, sig: b64u(await subtle.sign({ name: "Ed25519" }, signer, signed(id, body))) };
}

// Открывает конверт. Бросает, если подпись не менеджера, шифр подменён, письмо старое или не того вида.
export async function open(env: Envelope, devicePriv: CryptoKey, devicePub: string, managerPub: string, now = Date.now()): Promise<Letter> {
  if (env?.v !== 1 || !isKey(env.eph, 32) || !isKey(env.iv, 12) || !isKey(env.sig, 64) || typeof env.ct !== "string" || env.ct.length > 8000) throw new Error("конверт не того вида");
  const id = await boxId(devicePub);
  const mk = await subtle.importKey("raw", unb64u(managerPub), { name: "Ed25519" }, false, ["verify"]);
  if (!(await subtle.verify({ name: "Ed25519" }, mk, unb64u(env.sig), signed(id, env)))) throw new Error("подпись не менеджера");
  const ephPub = unb64u(env.eph);
  const ephKey = await subtle.importKey("raw", ephPub, { name: "X25519" }, false, []);
  const key = await aesKey(await x25519(ephKey, devicePriv), ephPub, unb64u(devicePub));
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(env.iv), additionalData: te.encode(`${V}:${id}`) }, key, unb64u(env.ct));
  const l = JSON.parse(td.decode(pt)) as Letter;
  if (l?.v !== 1 || !/^\d+:[\w-]{30,}$/.test(l.token ?? "") || !l.bot?.id || !l.bot.username || !l.owner?.id) throw new Error("письмо не того вида");
  if (now - l.at > FRESH_MS || l.at - now > 120_000) throw new Error("письмо устарело");
  return l;
}

// ── клиент ящика ─────────────────────────────────────────────────────────────
// POST /v1/box/{id} — положить конверт; GET /v1/box/{id}?wait=25 — дождаться конвертов (до 25 с). Без ключей и паролей.

export async function postBox(relay: string, id: string, env: Envelope): Promise<void> {
  const r = await fetch(`${relay.replace(/\/$/, "")}/v1/box/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`ящик не принял конверт: HTTP ${r.status}`);
}

export async function waitBox(relay: string, id: string, waitSec = 25): Promise<Envelope[]> {
  const r = await fetch(`${relay.replace(/\/$/, "")}/v1/box/${id}?wait=${waitSec}`, { signal: AbortSignal.timeout((waitSec + 15) * 1000) });
  if (!r.ok) throw new Error(`ящик не ответил: HTTP ${r.status}`);
  const j = (await r.json()) as { messages?: Envelope[] };
  return Array.isArray(j.messages) ? j.messages.slice(0, 8) : [];
}
