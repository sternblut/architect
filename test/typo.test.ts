import { describe, expect, test } from "bun:test";
import { noFinalDot, tameBold, typograph, urlsToButtons } from "../src/typo";

const NB = "\u00a0";
describe("типограф", () => {
  test("страница лимитов Claude — кнопкой «Докупить лимит Claude», а не голым адресом (не слать к Mac за /usage-credits)", () => {
    const r = urlsToButtons("Продолжить раньше — докупить лимит.\nhttps://claude.ai/settings/usage");
    expect(r.links).toEqual([{ text: "Докупить лимит Claude", url: "https://claude.ai/settings/usage" }]);
    expect(r.md).toBe("Продолжить раньше — докупить лимит.");
  });

  test("предлог не висит в конце строки, тире длинное и неразрывное, диапазон — короткое тире", () => {
    expect(typograph("Лимит хватит до сброса в четверг")).toBe(`Лимит хватит до${NB}сброса в${NB}четверг`);
    expect(typograph("A* - мобильная версия готова")).toBe(`A*${NB}— мобильная версия готова`);
    expect(typograph("с 10:00 - 12:00, правки 3-5")).toBe(`с${NB}10:00${NB}— 12:00, правки 3–5`);
    expect(typograph("стояли 3,5 часа")).toBe(`стояли 3,5${NB}часа`);
  });
  test("ё в частых словах и «ёлочки» вместо прямых кавычек", () => {
    expect(typograph('Отчет ждет ответа "принято", еще идет')).toBe(`Отчёт ждёт ответа «принято», ещё идёт`);
  });
  test("код, адреса и ссылки не трогаются", () => {
    const s = "в `rm -f a - b` и https://x.ru/a-b и [в тексте](https://y.ru/c-d)";
    expect(typograph(s)).toBe(`в${NB}\`rm -f a - b\` и${NB}https://x.ru/a-b и${NB}[в тексте](https://y.ru/c-d)`);
  });
});

describe("жирное и точка", () => {
  test("в коротком сообщении жирного нет", () => {
    expect(tameBold("**«Регламенты» обновили версию по той же ссылке**\nСмотреть на iPhone")).toBe("«Регламенты» обновили версию по той же ссылке\nСмотреть на iPhone");
  });
  test("в длинном — только первый фрагмент до 30 знаков; имена в списке — обычным", () => {
    expect(tameBold("**2 ждут вашего решения**\n**Каталог** — ответ\n**Арена** — приёмка\nОстальные работают")).toBe("**2 ждут вашего решения**\nКаталог — ответ\nАрена — приёмка\nОстальные работают");
    // экранированная звёздочка внутри жирного («A\*»): иначе вопрос оставался жирным в три строки
    expect(tameBold("**Каталог A\\* 2025: ставить метку «новинка» у новой позиции № 24?**\nСпрашивает сессия «Анализ отзывов»")).toBe("Каталог A\\* 2025: ставить метку «новинка» у новой позиции № 24?\nСпрашивает сессия «Анализ отзывов»");
    expect(tameBold("**9 сессий, 1 ждёт вашего решения: Каталог — вопрос**\nа\nб\nв")).toBe("9 сессий, 1 ждёт вашего решения: Каталог — вопрос\nа\nб\nв");
  });
  test("карточка с кодом в подробностях: длинный жирный заголовок становится обычным, код не тронут", () => {
    const card = "**Выложить «Маяк»: 3 ссылки «Методики» ведут на новые страницы**\nОбновится beacon.example.com\nПрежнюю версию можно вернуть\n\n<details><summary>Что изменится</summary>\n\n```\na **b** c\n```\n\n</details>";
    expect(tameBold(card)).toBe(card.replace("**Выложить «Маяк»: 3 ссылки «Методики» ведут на новые страницы**", "Выложить «Маяк»: 3 ссылки «Методики» ведут на новые страницы"));
  });
  test("без точки в конце, сокращения и вопросы не трогаем", () => {
    expect(noFinalDot("Ссылка была готова с 21:47 — я её пропустил.")).toBe("Ссылка была готова с 21:47 — я её пропустил");
    expect(noFinalDot("Что дальше?")).toBe("Что дальше?");
    expect(noFinalDot("Пятичасового потрачено 40%.")).toBe("Пятичасового потрачено 40%");
    expect(noFinalDot("и т. д.")).toBe("и т. д.");
  });
});

describe("длинный адрес — кнопкой", () => {
  test("ссылка на просмотр уходит в кнопку, хвост «по той же ссылке:» убран", () => {
    const r = urlsToButtons("Регламенты обновили версию по той же ссылке: https://claude.ai/artifact/ExampleArtifact0000001");
    expect(r.md).toBe("Регламенты обновили версию");
    expect(r.links).toEqual([{ text: "Ссылка для просмотра", url: "https://claude.ai/artifact/ExampleArtifact0000001" }]);
  });
  test("короткий адрес и ссылки в тексте остаются; одинаковые адреса — одна кнопка", () => {
    expect(urlsToButtons("Сайт beacon.example.com и https://beacon.example.com/").md).toBe("Сайт beacon.example.com и https://beacon.example.com/");
    const r = urlsToButtons("A: https://github.com/acme/astar/pull/6\nснова https://github.com/acme/astar/pull/6");
    expect(r.links.length).toBe(1);
    expect(r.links[0].text).toBe("Изменения на GitHub");
    expect(urlsToButtons("[версия](https://claude.ai/artifact/ExampleArtifact0000001)").links.length).toBe(0);
  });
  test("выкладка не прошла или затянулась — кнопка «Проверки на GitHub», а не адрес", () => {
    expect(urlsToButtons("Выкладка не прошла\nhttps://github.com/acme/beacon/actions/runs/123").links[0].text).toBe("Проверки на GitHub");
    const r = urlsToButtons("Выкладка идёт дольше 45 минут\nhttps://github.com/acme/beacon/actions");
    expect(r).toEqual({ md: "Выкладка идёт дольше 45 минут", links: [{ text: "Проверки на GitHub", url: "https://github.com/acme/beacon/actions" }] });
  });
});

// без подписей под ответом встали бы три одинаковые «Ссылка для просмотра»
test("несколько ссылок — подписи из своей строки: имя и название", () => {
  const md = "**Регламенты** — «Регламенты службы поддержки», сегодня в 18:35:\nhttps://claude.ai/artifact/ExampleArtifact0000003\n\n**Регламенты** — сегодня в 17:49:\nhttps://claude.ai/artifact/ExampleArtifact0000004\n\n**A\\*** — сегодня в 15:08:\nhttps://claude.ai/artifact/ExampleArtifact0000005";
  const r = urlsToButtons(md);
  expect(r.links.map((l) => l.text)).toEqual(["Регламенты службы поддержки", "Регламенты — сегодня в 17:49", "A* — сегодня в 15:08"]);
  expect(urlsToButtons("Новая страница: https://claude.ai/artifact/ExampleArtifact0000001").links[0].text).toBe("Ссылка для просмотра"); // одна — как раньше
});

test("подпись кнопки — заголовок страницы из реестра, иначе своя строка; две версии одной страницы — по времени", () => {
  const titles: Record<string, string> = { "https://claude.ai/artifact/ExampleArtifact0000006": "Первые экраны регламентов" };
  const pageTitle = (u: string) => titles[u];
  const board = urlsToButtons("Регламентам нужен ваш выбор первых экранов. На доске три варианта: https://claude.ai/artifact/ExampleArtifact0000006", pageTitle);
  expect(board.links[0].text).toBe("Первые экраны регламентов");
  const three = urlsToButtons("**Три варианта нового сайта A\\***\nA, крупные карточки: https://claude.ai/artifact/ExampleArtifact0000007\nB, длинная лента: https://claude.ai/artifact/ExampleArtifact0000008\nC, журнальная вёрстка: https://claude.ai/artifact/ExampleArtifact0000002", pageTitle);
  expect(three.links.map((l) => l.text)).toEqual(["A, крупные карточки", "B, длинная лента", "C, журнальная вёрстка"]);
  const facts = urlsToButtons("Регламенты — «Минимализм», сегодня в 15:06: https://claude.ai/artifact/ExampleArtifact0000009\nРегламенты — «Минимализм», сегодня в 10:22: https://claude.ai/artifact/ExampleArtifact0000010", pageTitle);
  expect(facts.links.map((l) => l.text)).toEqual(["Минимализм, 15:06", "Минимализм, 10:22"]);
  expect(urlsToButtons("«Блог A* 2025 — заметки, разборы и ответы читателям»: https://claude.ai/artifact/ExampleArtifact0000005").links[0].text).toBe("Блог A* 2025 — заметки, разборы и…");
});

// на экране блокировки строки без знака в конце слипаются: «…на сайте Прогон CI на v15 и выкладка прошли…»
test("строки-фразы архитектора получают точку, код и заголовки — нет", async () => {
  const { lineDots } = await import("../src/typo");
  expect(lineDots("Маяк: ссылки исправлены, на сайте\nПроверки и выкладка прошли\nПроверил снимком главную")).toBe("Маяк: ссылки исправлены, на сайте.\nПроверки и выкладка прошли.\nПроверил снимком главную.");
  expect(lineDots("**Работают:** A*, Регламенты\nНа связи")).toBe("**Работают:** A*, Регламенты.\nНа связи");
  expect(lineDots("Вот так:\n```\nls -la\n```\n| a | b |")).toBe("Вот так:\n```\nls -la\n```\n| a | b |");
  expect(lineDots("Ждут вашего решения: Арена?")).toBe("Ждут вашего решения: Арена?");
});
