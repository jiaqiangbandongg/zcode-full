// commands/query 的 session-scoped lazy index。
// loader 每 session 只执行一次；新 transcript/marker/child/discarded 事实用 record 增量并入。
import type { CommandAck, CommandKey } from "@zcode/shared/zcode-protocol-v4";

export type PersistentCommandFactSource = "transcript" | "timeline" | "child" | "discarded";

export interface PersistentCommandIndexSeed {
  workspacePath: string;
  workspaceIdentity?: string;
  facts?: Partial<Record<PersistentCommandFactSource, readonly CommandAck[]>>;
}

export interface PersistentCommandIndexTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface PersistentCommandIndexHost {
  loadSession(sessionId: string): Promise<PersistentCommandIndexSeed | null>;
}

interface SessionIndex {
  workspaceKey: string;
  facts: Record<PersistentCommandFactSource, Map<string, CommandAck>>;
}

function workspaceKey(target: PersistentCommandIndexTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function emptyFacts(): SessionIndex["facts"] {
  return {
    transcript: new Map(),
    timeline: new Map(),
    child: new Map(),
    discarded: new Map(),
  };
}

export class PersistentCommandIndex {
  private readonly sessions = new Map<string, Promise<SessionIndex | null>>();

  constructor(private readonly host: PersistentCommandIndexHost) {}

  async lookup(source: PersistentCommandFactSource, key: CommandKey): Promise<CommandAck | null> {
    if (key.sessionId === null) return null;
    const index = await this.ensureSession(key.sessionId);
    return index?.facts[source].get(key.commandId) ?? null;
  }

  /**
   * transcript append / marker settle / child create / discarded ledger 写入后调用；不重扫全量。
   * expected target 与首次 load 得到的 workspaceKey 不一致时明确拒绝，防同路径远端串线。
   */
  async record(
    target: PersistentCommandIndexTarget,
    sessionId: string,
    source: PersistentCommandFactSource,
    ack: CommandAck,
  ): Promise<void> {
    const index = await this.ensureSession(sessionId);
    if (!index) throw new Error("fault.command.querySessionNotFound");
    if (index.workspaceKey !== workspaceKey(target)) {
      throw new Error("fault.command.queryForeignWorkspace");
    }
    index.facts[source].set(ack.commandId, ack);
  }

  invalidate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private ensureSession(sessionId: string): Promise<SessionIndex | null> {
    let pending = this.sessions.get(sessionId);
    if (!pending) {
      pending = this.host.loadSession(sessionId).then((seed) => {
        if (!seed) return null;
        const facts = emptyFacts();
        for (const source of ["transcript", "timeline", "child", "discarded"] as const) {
          for (const ack of seed.facts?.[source] ?? []) facts[source].set(ack.commandId, ack);
        }
        return { workspaceKey: workspaceKey(seed), facts };
      });
      // 读取失败不缓存 rejected Promise；下次 query 可在 store 恢复后重试。
      pending.catch(() => {
        if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
      });
      pending.then(
        (index) => {
          // unknown/session-not-found 不是事实，不能缓存；后续 transcript 落盘后必须可见。
          if (index === null && this.sessions.get(sessionId) === pending) {
            this.sessions.delete(sessionId);
          }
        },
        () => {},
      );
      this.sessions.set(sessionId, pending);
    }
    return pending;
  }
}
