// Host secrets (bot token, hook secret, manager key) live in the macOS Keychain, not in files.
// Tests set ARCH_STATE_DIR and get plain files in the state folder instead.
// CLI: `has` checks for a bot token, `token` asks for one, `forget` deletes the host secrets (archi uninstall).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE, config, tr } from "./config";

const SERVICE = `${config.keychainService}-hook`;
export const MANAGER_SERVICE = `${config.keychainService}-manager`;
const testFile = (name: string) => (process.env.ARCH_STATE_DIR ? join(STATE, name) : null);
const SECURITY = "/usr/bin/security";

export function readSecret(service: string, fileName = `${service}.secret`): string {
  const f = testFile(fileName);
  if (f) return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  const p = Bun.spawnSync([SECURITY, "find-generic-password", "-a", config.keychainAccount, "-s", service, "-w"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

export function writeSecret(service: string, value: string, fileName = `${service}.secret`) {
  const f = testFile(fileName);
  if (f) return writeFileSync(f, value, { mode: 0o600 });
  const p = Bun.spawnSync([SECURITY, "add-generic-password", "-a", config.keychainAccount, "-s", service, "-U", "-w", value], { stdout: "ignore", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`could not save the secret to the Keychain: ${p.stderr.toString().trim()}`);
}

export function deleteSecret(service: string, fileName = `${service}.secret`) {
  const f = testFile(fileName);
  if (f) return rmSync(f, { force: true });
  Bun.spawnSync([SECURITY, "delete-generic-password", "-a", config.keychainAccount, "-s", service], { stdout: "ignore", stderr: "ignore" });
}

export const readHookSecret = () => readSecret(SERVICE, "hook-secret");

export function ensureHookSecret(): string {
  const have = readHookSecret();
  if (have.length >= 32) return have;
  const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writeSecret(SERVICE, fresh, "hook-secret");
  return fresh;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "has") {
    // without reading the value
    const f = testFile(`${config.keychainService}.secret`);
    const has = f ? existsSync(f) : Bun.spawnSync([SECURITY, "find-generic-password", "-a", config.keychainAccount, "-s", config.keychainService], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    console.log(has ? "yes" : "no");
  } else if (cmd === "token") {
    // A hidden-input macOS dialog, straight into the Keychain: the token never passes through the Claude chat,
    // the logs or shell history. /architect:connect has no terminal to prompt in.
    const ask = tr("Вставьте токен бота от @BotFather", "Paste the bot token from @BotFather");
    const r = Bun.spawnSync(["/usr/bin/osascript", "-e", `text returned of (display dialog "${ask}" default answer "" with hidden answer with title "Architect" buttons {"${tr("Отмена", "Cancel")}", "OK"} default button "OK")`], { stdout: "pipe", stderr: "ignore" });
    const token = r.stdout.toString().trim();
    if (r.exitCode !== 0 || !token) {
      console.log(tr("Окно закрыто — токен не сохранён.", "The dialog was closed — the token was not saved."));
      process.exit(1);
    }
    if (!/^\d{5,}:[\w-]{30,}$/.test(token)) {
      console.log(tr("Это не похоже на токен бота: он выглядит как 123456789:AAHf… — скопируйте его из @BotFather целиком.", "That doesn’t look like a bot token: it looks like 123456789:AAHf… — copy it from @BotFather in full."));
      process.exit(1);
    }
    writeSecret(config.keychainService, token);
    console.log(tr("Токен в связке ключей.", "Token saved in the keychain."));
  } else if (cmd === "forget") {
    deleteSecret(config.keychainService);
    deleteSecret(SERVICE, "hook-secret");
    // this Mac's relay key too, or uninstall would leave it behind
    deleteSecret(`${config.keychainService}-relay`, "relay-key");
    // The manager signing key stays: installers already handed out are signed with it
    console.log(tr("Токен бота, секрет хуков и ключ дежурного удалены из связки ключей.", "Bot token, hook secret and relay key removed from the keychain."));
  }
}
