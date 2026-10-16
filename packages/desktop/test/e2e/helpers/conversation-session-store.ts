import { readTaskStoreSnapshotInBrowser } from "./conversation-session-store-snapshot-script.js";

export interface TaskStoreSnapshot {
  activeInputId: string | null;
  activeTaskId: string | null;
  activeTaskConfigOptions: ConfigOptionSnapshot[];
  error: string | null;
  hasPendingPermission: boolean;
  knownWorkspaceKeys: string[];
  lastSelectedModelStorage: Record<string, string | null>;
  messageCount: number;
  selectedProvider: string | null;
  selectedSupplierKey: string | null;
  queueCount: number;
  queuedTexts: string[];
  runtimeStatus: string | null;
  stopRequested: boolean;
  streamingAssistantCount: number;
  taskConfigOptions: ConfigOptionSnapshot[];
  taskId: string;
  taskMeta: {
    model: string | null;
    provider: string | null;
    targetId: string | null;
    targetObjective: string | null;
    targetStatus: string | null;
    title: string | null;
  } | null;
  timelineSummaries: TimelineSummarySnapshot[];
  uiError: string | null;
  workspaceConfigOptions: ConfigOptionSnapshot[];
  workspaceKey: string | null;
}

export interface V4ComposerDraftScopeSnapshot {
  exists: boolean;
  mode: string | null;
  modelSelection: {
    providerId: string;
    modelId: string;
    reasoningLevel: string | null;
  } | null;
  scopeId: string;
  text: string;
}

export interface ConfigOptionSnapshot {
  category: string | null;
  currentValue: string | null;
  id: string | null;
  optionValues: string[];
  status?: string | null;
  type: string | null;
}

export interface TimelineSummarySnapshot {
  goalIteration: number | null;
  id: string | null;
  inputId: string | null;
  operationId: string | null;
  status: string | null;
  targetId: string | null;
  type: string | null;
  verificationPassed: boolean | null;
}

/** 读取当前 v4 Composer 的唯一持久 Draft；不再探测已删除的 Zustand 草稿镜像。 */
export function getV4ComposerDraftScopeSnapshot(
  workspacePath: string,
  taskId: string | null,
  workspaceIdentity?: string,
): Promise<V4ComposerDraftScopeSnapshot> {
  return browser.execute(
    (workspacePathArg, taskIdArg, workspaceIdentityArg) => {
      const scopeId = taskIdArg ?? "__draft__";
      const workspaceKey = workspaceIdentityArg?.trim() || workspacePathArg;
      const storageKey = `zcode-v4-composer-drafts:v1:${encodeURIComponent(workspaceKey)}`;
      let draft: Record<string, unknown> | null = null;
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            scopes?: Record<string, Record<string, unknown>>;
          };
          draft = parsed.scopes?.[scopeId] ?? null;
        }
      } catch {
        draft = null;
      }
      const selection =
        draft?.modelSelection &&
        typeof draft.modelSelection === "object" &&
        !Array.isArray(draft.modelSelection)
          ? (draft.modelSelection as Record<string, unknown>)
          : null;
      const options =
        selection?.options &&
        typeof selection.options === "object" &&
        !Array.isArray(selection.options)
          ? (selection.options as Record<string, unknown>)
          : null;
      const providerId = typeof selection?.providerId === "string" ? selection.providerId : null;
      const modelId = typeof selection?.modelId === "string" ? selection.modelId : null;
      return {
        exists: draft !== null,
        mode: typeof draft?.mode === "string" ? draft.mode : null,
        modelSelection:
          providerId && modelId
            ? {
                providerId,
                modelId,
                reasoningLevel:
                  typeof options?.reasoningLevel === "string" ? options.reasoningLevel : null,
              }
            : null,
        scopeId,
        text: typeof draft?.text === "string" ? draft.text : "",
      };
    },
    workspacePath,
    taskId,
    workspaceIdentity,
  );
}

export async function getTaskStoreSnapshot(
  taskId: string,
  workspaceKey?: string,
): Promise<TaskStoreSnapshot> {
  const result = await browser.execute(readTaskStoreSnapshotInBrowser, taskId, workspaceKey);

  // 修复原因：WebDriver execute 的返回对象顶层字段名 `error` 会被 chromedriver
  // 当成协议错误处理，导致原本用于诊断的 store snapshot 被吞成 WebDriverError。
  return result.snapshot;
}

export async function waitForTaskStoreSnapshot(
  taskId: string,
  predicate: (snapshot: TaskStoreSnapshot) => boolean = (snapshot) =>
    snapshot.workspaceKey !== null,
  timeoutMsg = `没有在会话 store 中观察到 task: ${taskId}`,
  timeout = 30000,
): Promise<TaskStoreSnapshot> {
  let latest: TaskStoreSnapshot | null = null;

  try {
    await browser.waitUntil(
      async () => {
        latest = await getTaskStoreSnapshot(taskId);
        return predicate(latest);
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    const suffix = latest ? `; latest=${JSON.stringify(latest)}` : "";
    const causeMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`${timeoutMsg}${suffix}; cause=${causeMessage}`);
  }

  if (!latest) {
    throw new Error(`${timeoutMsg}; latest=null`);
  }

  // 修复原因：远端 CI 偶发先看到 DOM streaming，再看到 Zustand task map hydrate。
  // 用等待型读取让断言对真实运行状态收敛，而不是把一次性读不到 store 当业务失败。
  return latest;
}
