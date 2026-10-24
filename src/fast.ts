// Узнать сессию по слову владельца. Заготовленных ответов хоста здесь нет: разговор ведёт архитектор,
// живой, в режиме чат-бота.
import { config } from "./config";

// Слово владельца — часть имени сессии: само слово, его основа («маяка» → «Маяк») или псевдоним из настроек («астар» → A*).
// Кириллическая «А» в «А*» — как латинская: владелец набирает имя с русской раскладки.
export function fits(w: string, name: string): boolean {
  const lat = (x: string) => x.replace(/а(?=\*)/gi, "a");
  const site = config.sites.find((s) => s.name === name) as { aliases?: string[] } | undefined;
  const own = [...name.toLowerCase().split(/[^\p{L}\p{N}*]+/u), ...(site?.aliases ?? []).map((a) => a.toLowerCase())].filter(Boolean).map(lat);
  const stem = (x: string) => x.slice(0, Math.max(4, x.length - 2));
  const v = lat(w.toLowerCase());
  return own.some((n) => n === v || (v.length >= 4 && n.length >= 4 && (n.startsWith(stem(v)) || v.startsWith(stem(n)))));
}
