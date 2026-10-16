/**
 * Session 文件变更追踪器
 *
 * 记录 agent runtime 文件写入产生的 before/after 内容。
 * 同一文件在同一轮中被多次修改时，只保留首次 before 和最末 after（合并首尾）。
 *
 * 用途：
 * - Rewind：回滚到某一轮时，逆序还原 beforeContent
 * - 汇聚：获取整个 session 所有文件操作的最终结果
 */

// ---- 类型定义 ----

/** 单个文件在一轮中的变更快照（合并首尾） */
interface FileSnapshot {
  path: string;
  /** 该轮首次修改前的文件内容，null 表示新文件 */
  beforeContent: string | null;
  /** 该轮最后一次写入的内容 */
  afterContent: string;
  /** 该轮内被写入的次数 */
  writeCount: number;
}

/** 一轮对话的文件变更 */
interface TurnFileChanges {
  turnIndex: number;
  /** 该轮涉及的文件快照，key = path */
  snapshots: Map<string, FileSnapshot>;
  /** 该轮文件变更当前是否已应用在 workspace */
  fileState: "applied" | "reverted";
}

/** 可序列化的文件快照（用于持久化） */
interface SerializedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
}

/** 可序列化的轮次文件变更（用于持久化） */
interface SerializedTurnFileChanges {
  turnIndex: number;
  snapshots: SerializedFileSnapshot[];
  fileState?: "applied" | "reverted";
}

// ---- 追踪器 ----

export class SessionFileChangeTracker {
  private turns: TurnFileChanges[] = [];
  private currentTurnIndex = -1;

  /** 开始新一轮对话，推进 turnIndex */
  newTurn(): number {
    this.currentTurnIndex++;
    this.turns.push({
      turnIndex: this.currentTurnIndex,
      snapshots: new Map(),
      fileState: "applied",
    });
    return this.currentTurnIndex;
  }

  /**
   * 记录一次文件写入操作。
   * 应在 writeTextFile 执行前读取原文件内容，写入后调用此方法。
   *
   * @param path 文件路径
   * @param beforeContent 写入前的文件内容，null 表示新文件
   * @param afterContent 写入后的文件内容
   */
  record(path: string, beforeContent: string | null, afterContent: string): void {
    if (this.currentTurnIndex < 0) {
      // 如果还没有 newTurn，自动创建第一轮
      this.newTurn();
    }

    const currentTurn = this.turns[this.turns.length - 1]!;
    const existing = currentTurn.snapshots.get(path);

    if (existing) {
      // 同一文件同一轮：保留首次 before，更新 after
      existing.afterContent = afterContent;
      existing.writeCount++;
    } else {
      currentTurn.snapshots.set(path, {
        path,
        beforeContent,
        afterContent,
        writeCount: 1,
      });
    }
  }

  /** 获取指定轮次的文件变更 */
  getChangesForTurn(turnIndex: number): FileSnapshot[] {
    const turn = this.turns.find((t) => t.turnIndex === turnIndex);
    if (!turn) return [];
    return Array.from(turn.snapshots.values());
  }

  /** 获取指定轮次文件状态 */
  getFileStateForTurn(turnIndex: number): "applied" | "reverted" {
    return this.turns.find((turn) => turn.turnIndex === turnIndex)?.fileState ?? "applied";
  }

  /** 更新指定轮次文件状态 */
  setFileStateForTurn(turnIndex: number, fileState: "applied" | "reverted"): void {
    const turn = this.turns.find((item) => item.turnIndex === turnIndex);
    if (!turn) {
      return;
    }
    turn.fileState = fileState;
  }

  /** 获取指定轮次之后（不含该轮）的所有文件变更，按轮次正序 */
  getChangesAfterTurn(turnIndex: number): FileSnapshot[] {
    const result: FileSnapshot[] = [];
    for (const turn of this.turns) {
      if (turn.turnIndex > turnIndex) {
        result.push(...turn.snapshots.values());
      }
    }
    return result;
  }

  /**
   * 计算回滚到指定轮次所需的文件还原操作。
   * 返回每个文件应还原到的内容（null 表示应删除该文件）。
   * 逻辑：收集 toTurnIndex 之后所有轮次中每个文件最早的 beforeContent。
   * 如果该文件在 toTurnIndex 或之前也被修改过，则用那一轮的 afterContent。
   */
  getRewindOperations(toTurnIndex: number): Map<string, string | null> {
    const rewindOps = new Map<string, string | null>();

    // 从最新轮次往回遍历到 toTurnIndex（不含），每个文件持续覆写，
    // 最终留下的是该文件在回滚范围内最早出现的 beforeContent
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      if (turn.turnIndex <= toTurnIndex) break;

      for (const snapshot of turn.snapshots.values()) {
        rewindOps.set(snapshot.path, snapshot.beforeContent);
      }
    }

    // 如果文件在 toTurnIndex 或之前也被修改过，应该用那一轮的 afterContent
    for (const turn of this.turns) {
      if (turn.turnIndex > toTurnIndex) break;
      for (const snapshot of turn.snapshots.values()) {
        if (rewindOps.has(snapshot.path)) {
          rewindOps.set(snapshot.path, snapshot.afterContent);
        }
      }
    }

    return rewindOps;
  }

  /** 获取整个 session 中所有被修改过的文件及其最终内容 */
  getAllChangedFiles(): Map<string, { originalContent: string | null; finalContent: string }> {
    const result = new Map<string, { originalContent: string | null; finalContent: string }>();

    for (const turn of this.turns) {
      for (const snapshot of turn.snapshots.values()) {
        const existing = result.get(snapshot.path);
        if (existing) {
          // 更新 finalContent，保留 originalContent
          existing.finalContent = snapshot.afterContent;
        } else {
          result.set(snapshot.path, {
            originalContent: snapshot.beforeContent,
            finalContent: snapshot.afterContent,
          });
        }
      }
    }

    return result;
  }

  /** 获取当前轮次索引 */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  /** 对仅有消息历史、没有 fileChanges 的旧任务，补齐当前轮次游标 */
  restoreCurrentTurnIndex(turnIndex: number): void {
    if (!Number.isFinite(turnIndex)) {
      return;
    }

    // Bugfix: external import 这类历史任务往往只有 messages.turnIndex，没有 fileChanges。
    // 如果恢复时不把游标补到最后一轮，下一次 sendPrompt 会从 0 重新开始编号，
    // 让续聊消息和导入历史落到同一 turn，进一步把 fork/retry 的边界判断带歪。
    this.currentTurnIndex = Math.max(this.currentTurnIndex, Math.trunc(turnIndex));
  }

  /** 获取总轮次数 */
  getTurnCount(): number {
    return this.turns.length;
  }

  // ---- 序列化/反序列化（持久化用） ----

  /** 序列化为可 JSON 化的结构 */
  serialize(): SerializedTurnFileChanges[] {
    return this.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      snapshots: Array.from(turn.snapshots.values()),
      fileState: turn.fileState,
    }));
  }

  /** 从序列化数据恢复 */
  static deserialize(data: SerializedTurnFileChanges[]): SessionFileChangeTracker {
    const tracker = new SessionFileChangeTracker();
    for (const turn of data) {
      const snapshots = new Map<string, FileSnapshot>();
      for (const s of turn.snapshots) {
        snapshots.set(s.path, { ...s });
      }
      tracker.turns.push({
        turnIndex: turn.turnIndex,
        snapshots,
        fileState: turn.fileState ?? "applied",
      });
    }
    tracker.currentTurnIndex = data.length > 0 ? data[data.length - 1]!.turnIndex : -1;
    return tracker;
  }

  /** 截断到指定轮次（含），删除之后的所有记录 */
  truncateAfterTurn(turnIndex: number): void {
    this.turns = this.turns.filter((t) => t.turnIndex <= turnIndex);
    this.currentTurnIndex = this.turns.length > 0 ? this.turns[this.turns.length - 1]!.turnIndex : -1;
  }
}
