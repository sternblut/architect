// Голосовые владельца → текст, локально на Mac (mlx-whisper, Apple Silicon). Звук никуда не уходит.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { STATE, config, tr } from "./config";
import { clip, log, run } from "./util";

// Подсказка словаря: имена проектов и слова работы распознаются точнее (свои слова — voice.vocab в config.json).
const VOCAB = "Claude, GitHub, архитектор, сессия, выкладка, прогон, ветка, main, PR, репозиторий.";
const VOCAB_EN = "Claude, GitHub, architect, session, deploy, run, branch, main, PR, repository.";

export async function transcribe(path: string): Promise<string | null> {
  const v = config.voice;
  if (!v?.whisper || !existsSync(v.whisper)) return null;
  const dir = join(STATE, "voice");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = basename(path, extname(path));
  const out = join(dir, `${name}.txt`);
  const t = Date.now();
  const r = await run(
    // язык распознавания — язык установки: английский владелец говорит по-английски
    [v.whisper, path, "--model", v.model, "--language", tr(v.language, "en"), "--initial-prompt", v.vocab ?? tr(VOCAB, VOCAB_EN), "--output-format", "txt", "--output-dir", dir, "--output-name", name, "--verbose", "False"],
    { timeoutMs: 180_000, env: { ...process.env, HF_HUB_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false" } },
  );
  if (r.code !== 0 || !existsSync(out)) {
    log("voice", "не распознал голосовое", clip(r.stderr || r.stdout, 400));
    return null;
  }
  const text = readFileSync(out, "utf8").replace(/\s+/g, " ").trim();
  rmSync(out, { force: true });
  log("voice", `распознано за ${((Date.now() - t) / 1000).toFixed(1)} с: ${text.length} знаков`);
  return text || null;
}
