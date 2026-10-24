// Сессии, которые ждут ответа владельца, пока он не у Mac: хук Stop держится открытым,
// и ответ из Telegram возвращается в сессию как реплика владельца (decision: block + reason).
// Отпускается ответом, кнопкой «Пусть продолжает», возвращением владельца к Mac или по тайм-ауту.
type Hold = { resolve: (text: string | null) => void; since: number; messageIds: number[]; timer: Timer };

const holds = new Map<string, Hold>();

export const stopHolds = {
  has(sessionId: string) {
    return holds.has(sessionId);
  },
  wait(sessionId: string, timeoutMs: number, messageIds: number[] = []): Promise<string | null> {
    stopHolds.release(sessionId); // прежнее ожидание этой сессии больше не нужно
    return new Promise((resolve) => {
      const timer = setTimeout(() => stopHolds.release(sessionId), timeoutMs);
      holds.set(sessionId, { resolve, since: Date.now(), messageIds, timer });
    });
  },
  addMessages(sessionId: string, ids: number[]) {
    holds.get(sessionId)?.messageIds.push(...ids);
  },
  answer(sessionId: string, text: string): boolean {
    const h = holds.get(sessionId);
    if (!h) return false;
    holds.delete(sessionId);
    clearTimeout(h.timer);
    h.resolve(text);
    return true;
  },
  release(sessionId: string): number[] | null {
    const h = holds.get(sessionId);
    if (!h) return null;
    holds.delete(sessionId);
    clearTimeout(h.timer);
    h.resolve(null);
    return h.messageIds;
  },
  all(): string[] {
    return [...holds.keys()];
  },
};
