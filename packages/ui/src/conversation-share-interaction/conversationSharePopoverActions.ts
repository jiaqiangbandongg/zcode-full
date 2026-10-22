import type {
  ConversationShareSelectionState,
  ConversationShareSelectionDraft,
  ConversationShareDockState,
} from "@/store/conversationShareSelectionStore.js";

/** 同一 store 的范围事务命令；只持有临时 UI 勾选，不产生第二份已确认分享状态。 */
export function createConversationSharePopoverActions(
  set: (
    updater: (
      state: ConversationShareSelectionState,
    ) => Partial<ConversationShareSelectionState> | ConversationShareSelectionState,
  ) => void,
  getConversationShareDraft: (
    state: ConversationShareSelectionState,
    taskId: string,
  ) => ConversationShareSelectionDraft,
  getConversationShareDockState: (
    state: ConversationShareSelectionState,
    taskId: string,
  ) => ConversationShareDockState,
  defaultDockState: ConversationShareDockState,
): Pick<
  ConversationShareSelectionState,
  | "deselectProductTurn"
  | "openShare"
  | "closeShare"
  | "beginSelectionEdit"
  | "togglePendingRow"
  | "setAllPendingRowsSelected"
  | "confirmSelectionEdit"
  | "cancelSelectionEdit"
> {
  return {
    /**
     * 按 product turn 身份整轮取消选择。
     *
     * Bug 根因：旧实现让 UI 用 service 的 turnOrdinal 去索引自己的 per-query 列表，
     * 两套编号在含系统上下文轮或多 steer query 的会话里必然错位；而且 toggleRow 只
     * 排除一行，同一轮的其他 query 仍留在选择里，阻断轮根本没被移除。
     * 「取消该轮」的语义是整轮，因此按 productTurnId 一次性排除全部行，且幂等。
     */
    deselectProductTurn: (taskId, productTurnId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (!current.open || !productTurnId || state.dockStates[taskId]?.publishing) return state;
        // 问题详情与列表共用同一范围事务：编辑时只改 pending，取消不能泄漏到 confirmed。
        const editing = current.pendingExcludedRowIds != null;
        const excluded = new Set(current.pendingExcludedRowIds ?? current.excludedRowIds);
        let changed = false;
        for (const rowId of current.availableRowIds) {
          if (current.productTurnIdByRowId[rowId] !== productTurnId || excluded.has(rowId)) {
            continue;
          }
          excluded.add(rowId);
          changed = true;
        }
        if (!changed) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              [editing ? "pendingExcludedRowIds" : "excludedRowIds"]: [...excluded].sort(
                (left, right) => left - right,
              ),
            },
          },
          ...(!editing
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                    error: null,
                  },
                },
              }
            : {}),
        };
      }),
    openShare: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        const dock = getConversationShareDockState(state, taskId);
        if (dock.publishing || current.open) return state;
        // 成功结果只属于本次打开；新一轮必须清除 attempt，避免复用旧发布请求。
        const restart = Boolean(dock.publishedShareUrl);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              ...(restart ? { excludedRowIds: [] } : {}),
              open: true,
              pendingExcludedRowIds: null,
            },
          },
          ...(restart
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: { ...defaultDockState, title: dock.title },
                },
              }
            : {}),
        };
      }),
    closeShare: (taskId) =>
      set((state) => {
        if (state.dockStates[taskId]?.publishing) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...getConversationShareDraft(state, taskId),
              open: false,
              pendingExcludedRowIds: null,
            },
          },
        };
      }),
    beginSelectionEdit: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          !current.open ||
          state.dockStates[taskId]?.publishing ||
          state.dockStates[taskId]?.publishedShareUrl ||
          current.pendingExcludedRowIds != null
        )
          return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: [...current.excludedRowIds],
            },
          },
        };
      }),
    togglePendingRow: (taskId, rowId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          current.pendingExcludedRowIds == null ||
          !current.availableRowIds.includes(rowId) ||
          state.dockStates[taskId]?.publishing
        )
          return state;
        // 目录按 query 展示，发布按 product turn；同轮条目必须一起选择，避免摘要与实际发布范围不一致。
        const turnId = current.productTurnIdByRowId[rowId];
        const ids = turnId
          ? current.availableRowIds.filter((id) => current.productTurnIdByRowId[id] === turnId)
          : [rowId];
        const excluded = new Set(current.pendingExcludedRowIds);
        const remove = !excluded.has(rowId);
        for (const id of ids) {
          if (remove) excluded.add(id);
          else excluded.delete(id);
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: [...excluded].sort((a, b) => a - b),
            },
          },
        };
      }),
    setAllPendingRowsSelected: (taskId, selected) =>
      set((state) => {
        // 同一 product turn 可对应多条 query，批量赋值避免逐行 toggle 把同轮反复切回。
        const current = getConversationShareDraft(state, taskId);
        if (current.pendingExcludedRowIds == null || state.dockStates[taskId]?.publishing)
          return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: selected ? [] : [...current.availableRowIds],
            },
          },
        };
      }),
    cancelSelectionEdit: (taskId) =>
      set((state) => {
        if (state.dockStates[taskId]?.publishing) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...getConversationShareDraft(state, taskId),
              pendingExcludedRowIds: null,
            },
          },
        };
      }),
    confirmSelectionEdit: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.pendingExcludedRowIds == null || state.dockStates[taskId]?.publishing)
          return state;
        const excluded = current.pendingExcludedRowIds.filter((id) =>
          current.availableRowIds.includes(id),
        );
        if (current.availableRowIds.every((id) => excluded.includes(id))) return state;
        const changed =
          excluded.length !== current.excludedRowIds.length ||
          excluded.some((id) => !current.excludedRowIds.includes(id));
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: excluded,
              pendingExcludedRowIds: null,
            },
          },
          ...(changed
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                    error: null,
                  },
                },
              }
            : {}),
        };
      }),
  };
}
