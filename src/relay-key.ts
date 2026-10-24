// This Mac's Ed25519 key for the cloud relay. The private key stays in the Keychain; the printed public key
// goes to MAC_KEY in relay/wrangler.toml. Usage: bun src/relay-key.ts (creates the key on first run).
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
  if (r.code !== 0) throw new Error("could not save the key to the Keychain");
}
const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64url"), "Ed25519", true, ["sign"]);
console.log(`${tr("Открытый ключ Mac (не секрет) — MAC_KEY в relay/wrangler.toml", "Mac public key (not a secret) — MAC_KEY in relay/wrangler.toml")}:\n${(await crypto.subtle.exportKey("jwk", key)).x}`);
