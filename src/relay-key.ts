// Ключ Mac для дежурного в облаке. Закрытый — только в связке ключей; открытый (не секрет) печатается — его кладут в MAC_KEY Worker.
// bun src/relay-key.ts — создать, если ещё нет, и показать открытый ключ.
import { config, tr } from "./config";
import { KEY_SERVICE } from "./relay";
import { run } from "./util";

const who = ["-a", config.keychainAccount, "-s", KEY_SERVICE];
const have = await run(["security", "find-generic-password", ...who, "-w"]);
let pkcs8 = have.code === 0 ? have.stdout.trim() : "";
if (!pkcs8) {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", k.privateKey)).toString("base64url");
  const r = await run(["security", "add-generic-password", ...who, "-U", "-w", pkcs8]);
  if (r.code !== 0) throw new Error("не записал ключ в связку ключей");
}
const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), "Ed25519", true, ["sign"]);
console.log(`${tr("Открытый ключ Mac (не секрет) — MAC_KEY в relay/wrangler.toml", "Mac public key (not a secret) — MAC_KEY in relay/wrangler.toml")}:\n${(await crypto.subtle.exportKey("jwk", key)).x}`);
