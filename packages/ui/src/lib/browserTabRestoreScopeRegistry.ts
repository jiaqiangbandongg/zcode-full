export type BrowserTabRestoreAttempt = symbol;

interface BrowserTabRestoreScopeState {
  attempt: BrowserTabRestoreAttempt;
  status: "in-flight" | "completed";
}

/**
 * Browser shell 冷恢复按 workspace scope 去重，同时用 attempt token 隔离迟到 promise。
 * cleanup 只能撤销自己创建的 in-flight；旧 attempt 不得覆盖新 attempt 的完成状态。
 */
export class BrowserTabRestoreScopeRegistry {
  private readonly scopes = new Map<string, BrowserTabRestoreScopeState>();

  begin(scopeKey: string): BrowserTabRestoreAttempt | null {
    if (this.scopes.has(scopeKey)) return null;
    const attempt = Symbol(scopeKey);
    this.scopes.set(scopeKey, { attempt, status: "in-flight" });
    return attempt;
  }

  complete(scopeKey: string, attempt: BrowserTabRestoreAttempt): boolean {
    const current = this.scopes.get(scopeKey);
    if (!current || current.attempt !== attempt || current.status !== "in-flight") return false;
    current.status = "completed";
    return true;
  }

  cancel(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    this.releaseInFlight(scopeKey, attempt);
  }

  fail(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    this.releaseInFlight(scopeKey, attempt);
  }

  private releaseInFlight(scopeKey: string, attempt: BrowserTabRestoreAttempt): void {
    const current = this.scopes.get(scopeKey);
    if (current?.attempt === attempt && current.status === "in-flight") {
      this.scopes.delete(scopeKey);
    }
  }
}
