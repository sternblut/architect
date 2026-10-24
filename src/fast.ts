// Matching the owner's word to a session or site name.
import { config } from "./config";

// The word fits a part of the name, its stem ("маяка" → "Маяк") or a site alias from the settings.
// A Cyrillic "А" before "*" counts as Latin: "А*" typed on a Russian keyboard is "A*".
export function fits(w: string, name: string): boolean {
  const lat = (x: string) => x.replace(/а(?=\*)/gi, "a");
  const site = config.sites.find((s) => s.name === name) as { aliases?: string[] } | undefined;
  const own = [...name.toLowerCase().split(/[^\p{L}\p{N}*]+/u), ...(site?.aliases ?? []).map((a) => a.toLowerCase())].filter(Boolean).map(lat);
  const stem = (x: string) => x.slice(0, Math.max(4, x.length - 2));
  const v = lat(w.toLowerCase());
  return own.some((n) => n === v || (v.length >= 4 && n.length >= 4 && (n.startsWith(stem(v)) || v.startsWith(stem(n)))));
}
