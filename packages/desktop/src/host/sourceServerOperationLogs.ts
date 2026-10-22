import { Emitter } from "@zcode/rpc";
import {
  normalizeRemoteConnectionError,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
  sourceServerOperationLogSchema,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerOperationLog,
} from "@zcode/shared";
import type { TransportContext } from "@zcode/server/source-server";

type Operation = { sequence: number; logs: SourceServerOperationLog[] };

/** Host 内唯一日志历史；连接/更新共用，Renderer 的订阅仅作为查询失效通知。 */
export class SourceServerOperationLogs {
  private sequence = 0;
  private readonly profileKeys = new Map<string, string>();
  private readonly operations = new Map<string, Operation>();
  private readonly emitter = new Emitter<SourceServerOperationLog>();
  readonly onDidAppend = this.emitter.event;

  constructor(private readonly now: () => number) {}

  read(
    profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">,
  ): SourceServerOperationLog[] {
    const key = profile.sourceServerId ? `source:${profile.sourceServerId}` : this.profileKeys.get(profile.profileId);
    const operation = key ? this.operations.get(key) : undefined;
    return operation?.logs.map((entry) => ({ ...entry })) ?? [];
  }

  removeProfile(profileId: string): void {
    const key = this.profileKeys.get(profileId);
    this.profileKeys.delete(profileId);
    if (key && ![...this.profileKeys.values()].includes(key)) this.operations.delete(key);
  }

  async run<T extends { sourceServerId: string; profileId: string }>(
    operation: SourceServerOperationLog["operation"],
    profile: ConnectionProfile,
    target: RemoteTarget,
    context: TransportContext | undefined,
    task: (context: TransportContext) => Promise<T>,
  ): Promise<T> {
    const current: Operation = { sequence: ++this.sequence, logs: [] };
    let key = profile.sourceServerId ? `source:${profile.sourceServerId}` : `profile:${profile.profileId}`;
    let ownerProfileId = profile.profileId;
    const previous = this.operations.get(key);
    this.profileKeys.set(ownerProfileId, key);
    this.operations.set(key, current);
    const secrets =
      target.kind === "ssh"
        ? [target.password, target.privateKeyPassphrase, target.privateKeyPath].filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    let phase = "probe";
    let active = true;
    const emit = (
      event: { phase: string; message: string; progress?: number },
      level: SourceServerOperationLog["level"] = "info",
    ) => {
      if (!active || this.operations.get(key) !== current) return;
      phase = event.phase;
      const message = sanitizeRemoteConnectionLog(event.message, secrets);
      if (!message) return;
      const entry = sourceServerOperationLogSchema.parse({
        ...event,
        message,
        level,
        profileId: ownerProfileId,
        operation,
        timestamp: this.now(),
      });
      if (entry.progress !== undefined) {
        current.logs = current.logs.filter(
          (previous) => previous.phase !== entry.phase || previous.progress === undefined,
        );
      }
      current.logs = [...current.logs, entry].slice(-100);
      this.emitter.fire(entry);
      context?.onLog?.({ ...event, message, level });
    };
    emit({ phase, message: "Checking the remote device" });
    try {
      const result = await task({ ...context, onLog: (event) => emit(event) });
      const nextKey = `source:${result.sourceServerId}`;
      if (nextKey !== key && this.operations.get(key) === current) {
        // 身份换代生成新 Source/Profile；旧设备只保留换代前自己的历史。
        if (profile.sourceServerId && previous) this.operations.set(key, previous);
        else this.operations.delete(key);
      }
      key = nextKey;
      ownerProfileId = result.profileId;
      this.profileKeys.set(ownerProfileId, key);
      const latest = this.operations.get(key);
      if (!latest || latest.sequence <= current.sequence) this.operations.set(key, current);
      emit({
        phase: "ready",
        message:
          operation === "update" ? "Source Server update completed" : "Remote connection ready",
        progress: 1,
      });
      return result;
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      emit({ phase, message: failure.message }, remoteConnectionFailureLogLevel(failure.code));
      // 保留现有领域 Error 的 instanceof 语义，同时为 RPC 提供可识别的码与非空消息。
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), {
        ...failure,
        message:
          sanitizeRemoteConnectionLog(failure.message, secrets) || "Remote connection failed",
      });
    } finally {
      active = false;
    }
  }

  dispose(): void {
    this.profileKeys.clear();
    this.operations.clear();
    this.emitter.dispose();
  }
}
