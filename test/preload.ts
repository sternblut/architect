// Tests expect Moscow time while the bot shows Mac local time, so the run must not depend on the machine's time zone
process.env.TZ = "Europe/Moscow";
// Tests use their own settings (sites, repos, Keychain service), not the repo's config.json template
process.env.ARCH_CONFIG ??= `${import.meta.dir}/config.json`;
