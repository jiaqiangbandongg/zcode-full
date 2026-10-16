import type { BotGroupInputProgress, BotGroupInputStatus } from "@zcode/shared";

const rank = (state: BotGroupInputStatus) =>
  state === "waiting" ? 0 : state === "working" ? 1 : 2;

export function createGroupQueueCardSync(deps: {
  read(key: string): Promise<BotGroupInputProgress | undefined>;
  mutate(
    key: string,
    update: (current: BotGroupInputProgress) => BotGroupInputProgress,
  ): Promise<BotGroupInputProgress | undefined>;
  render(key: string, messageId: string, status: BotGroupInputStatus): Promise<void>;
}) {
  const operations = new Map<string, Promise<void>>();
  const change = (
    key: string,
    mutate: (current: BotGroupInputProgress) => BotGroupInputProgress,
  ) => {
    const operation = (operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await deps.mutate(key, mutate);
        const current = await deps.read(key);
        if (!current?.cardMessageId || current.cardStatus === current.status) return;
        await deps.render(key, current.cardMessageId, current.status);
        await deps.mutate(key, (latest) => ({ ...latest, cardStatus: current.status }));
      });
    operations.set(key, operation);
    void operation
      .finally(() => {
        if (operations.get(key) === operation) operations.delete(key);
      })
      .catch(() => {});
    return operation;
  };
  return {
    update: (key: string, status: BotGroupInputStatus) =>
      change(key, (current) => ({
        ...current,
        // 原实现只改表情；卡片也必须记录单向生命周期，迟到的 admission 不能覆盖终态。
        status: rank(status) > rank(current.status) ? status : current.status,
      })),
    attach: (key: string, cardMessageId: string) =>
      change(key, (current) => ({
        ...current,
        cardMessageId,
        cardStatus: "waiting",
      })),
  };
}
