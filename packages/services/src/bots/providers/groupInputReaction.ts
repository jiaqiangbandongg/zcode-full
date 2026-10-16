export type GroupInputReaction = "waiting" | "working" | "done" | "failed" | "cancelled";

const rank: Record<GroupInputReaction, number> = {
  waiting: 0,
  working: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
};

export function createGroupInputReactionUpdater(
  apply: (key: string, state: GroupInputReaction) => Promise<void>,
) {
  const entries = new Map<
    string,
    {
      desired: GroupInputReaction;
      applied?: GroupInputReaction;
      pending: Promise<void>;
    }
  >();
  return (key: string, state: GroupInputReaction): Promise<void> => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { desired: state, pending: Promise.resolve() };
      entries.set(key, entry);
    } else if (
      rank[state] < rank[entry.desired] ||
      (rank[entry.desired] === 2 && state !== entry.desired)
    ) {
      return Promise.resolve();
    }
    entry.desired = state;
    const current = entry;
    // 接收确认可能晚于开始/结束事件；单消息串行并禁止状态回退，避免覆盖终态。
    current.pending = current.pending
      .catch(() => {})
      .then(async () => {
        if (current.applied === state) return;
        await apply(key, state);
        current.applied = state;
      });
    return current.pending;
  };
}
