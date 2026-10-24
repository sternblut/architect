// Конверт с токеном личного бота: открывает только тот Mac, на чей ключ запечатан, и только от своего менеджера.
import { describe, expect, test } from "bun:test";
import { boxId, deviceKeys, isDevicePub, managerKey, newManagerKey, open, pairCode, seal, type Letter } from "../src/box";

const TOKEN = "7000000001:AAbbccddeeffgghhiijjkkllmmnnooppqqr";
const letter = (at = Date.now()): Letter => ({ v: 1, token: TOKEN, bot: { id: 7000000001, username: "olga_t_arch_bot" }, owner: { id: 5550001, name: "Ольга Тестова", username: "olga_t" }, manager: "test_bot", at });

describe("конверт", () => {
  test("Mac открывает конверт от своего менеджера", async () => {
    const dev = await deviceKeys();
    const m = await managerKey(await newManagerKey());
    const env = await seal(letter(), dev.pub, m.priv);
    expect(JSON.stringify(env)).not.toContain("AAbbcc"); // в конверте токена открытым текстом нет
    const l = await open(env, dev.priv, dev.pub, m.pub);
    expect(l.token).toBe(TOKEN);
    expect(l.owner.id).toBe(5550001);
  });

  test("подпись не того менеджера, подменённый шифр, чужой Mac, старое письмо — не открываются", async () => {
    const dev = await deviceKeys();
    const other = await deviceKeys();
    const m = await managerKey(await newManagerKey());
    const fake = await managerKey(await newManagerKey());
    const env = await seal(letter(), dev.pub, m.priv);
    await expect(open(env, dev.priv, dev.pub, fake.pub)).rejects.toThrow();
    // меняем знак в середине: каждый его бит — данные. Прежняя замена предпоследнего знака иногда ничего не меняла
    // (знак уже был «A» или «B», либо менялись только биты-заполнители) — и тест падал раз в несколько прогонов
    const i = env.ct.length >> 1;
    const flipped = { ...env, ct: env.ct.slice(0, i) + (env.ct[i] === "A" ? "B" : "A") + env.ct.slice(i + 1) };
    await expect(open(flipped, dev.priv, dev.pub, m.pub)).rejects.toThrow();
    await expect(open(env, other.priv, other.pub, m.pub)).rejects.toThrow();
    const old = await seal(letter(Date.now() - 20 * 60_000), dev.pub, m.priv);
    await expect(open(old, dev.priv, dev.pub, m.pub)).rejects.toThrow("устарело");
  });

  test("конверт, запечатанный злоумышленником на тот же ключ Mac, не принимается без подписи менеджера", async () => {
    const dev = await deviceKeys();
    const m = await managerKey(await newManagerKey());
    const evil = await managerKey(await newManagerKey());
    const env = await seal({ ...letter(), owner: { id: 666, name: "Ольга Тестова" } }, dev.pub, evil.priv);
    await expect(open(env, dev.priv, dev.pub, m.pub)).rejects.toThrow("подпись");
  });

  test("имя ящика выводится из ключа Mac и сам ключ не раскрывает", async () => {
    const dev = await deviceKeys();
    expect(isDevicePub(dev.pub)).toBe(true);
    expect(dev.pub.length).toBe(43); // «c» + 43 знака влезают в ссылку /start (до 64)
    const id = await boxId(dev.pub);
    expect(id).toBe(await boxId(dev.pub));
    expect(id).toMatch(/^[\w-]{32}$/);
    expect(dev.pub).not.toContain(id);
    expect(isDevicePub("c".repeat(42))).toBe(false); // не 32 байта
    expect(isDevicePub("<script>")).toBe(false);
  });

  test("код сверки — четыре цифры из ключа Mac, у разных Mac разный", async () => {
    const a = await deviceKeys();
    const b = await deviceKeys();
    expect(await pairCode(a.pub)).toMatch(/^\d{4}$/);
    expect(await pairCode(a.pub)).toBe(await pairCode(a.pub));
    const codes = new Set(await Promise.all(Array.from({ length: 20 }, async () => pairCode((await deviceKeys()).pub))));
    expect(codes.size).toBeGreaterThan(15); // не одно и то же число
    expect(b.pub).not.toBe(a.pub);
  });
});
