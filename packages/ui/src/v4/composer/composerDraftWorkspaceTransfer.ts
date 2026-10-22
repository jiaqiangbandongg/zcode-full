import type { ChatComposerAttachment } from "@/lib/chatAttachments.js";
import { readComposerAttachmentScope } from "@/store/composerAttachmentUploadStore.js";
import {
  readV4ComposerDraft,
  readComposerWorkspaceScope,
  composerScopeKey,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

export interface ComposerDraftHandoff {
  sourceWorkspaceKey: string;
  draft: Omit<V4ComposerDraft, "updatedAt">;
  attachments: readonly ChatComposerAttachment[];
}

type DraftReader = () => Omit<ComposerDraftHandoff, "sourceWorkspaceKey">;
const draftReaders = new Map<string, DraftReader>();
const incomingAttachments = new Map<
  string,
  { draftFocusVersion: number; attachments: readonly ChatComposerAttachment[] }
>();

/** 读取编辑器当前值，避免把尚未到持久化时点的文字丢在旧工作区。 */
export function registerV4ComposerDraftReader(workspaceKey: string, read: DraftReader): () => void {
  draftReaders.set(workspaceKey, read);
  return () => {
    if (draftReaders.get(workspaceKey) === read) draftReaders.delete(workspaceKey);
  };
}

export function captureV4ComposerDraftHandoff(
  workspacePath: string,
  workspaceIdentity?: string,
  clientNamespace = "desktop",
): ComposerDraftHandoff {
  const sourceWorkspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  // 重建 Root 后编辑器可能尚未挂载；交接回退也要读取同一客户端的项目草稿。
  const scope = readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace);
  return {
    sourceWorkspaceKey,
    ...(draftReaders.get(sourceWorkspaceKey)?.() ?? {
      draft: readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope) ?? {
        text: "",
      },
      attachments: readComposerAttachmentScope(
        `${sourceWorkspaceKey}\0${V4_DRAFT_SCOPE_ROOT}${scope ? `:${composerScopeKey(scope)}` : ""}`,
      ),
    }),
  };
}

/** 手机切项目会重建 Root；这里只暂存一次性交接命令，File 不落盘。 */
export function stageV4ComposerDraftAttachments(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  draftFocusVersion: number,
  handoff: ComposerDraftHandoff,
): void {
  const targetKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  // 同目录的新项目也有独立的附件 scope；显式创建交接不能因 cwd 相同而跳过。
  incomingAttachments.set(targetKey, { draftFocusVersion, attachments: handoff.attachments });
}

export function consumeV4ComposerDraftAttachments(
  workspaceKey: string,
  draftFocusVersion: number,
): readonly ChatComposerAttachment[] | null {
  const pending = incomingAttachments.get(workspaceKey);
  incomingAttachments.delete(workspaceKey);
  // 目标草稿若已换代，晚挂载的输入区不能接收旧命令。
  return pending?.draftFocusVersion === draftFocusVersion ? pending.attachments : null;
}

interface ComposerDraftWorkspaceTransferRequest {
  sourceWorkspacePath: string;
  sourceWorkspaceIdentity?: string;
  targetWorkspacePath: string;
  targetWorkspaceIdentity?: string;
}

let pendingRequest: ComposerDraftWorkspaceTransferRequest | null = null;

function getWorkspaceKey(path: string, identity?: string): string {
  return identity?.trim() || path;
}

export function requestV4ComposerDraftWorkspaceTransfer(
  request: ComposerDraftWorkspaceTransferRequest,
): void {
  pendingRequest = request;
}

export function consumeV4ComposerDraftWorkspaceTransferRequest(
  transition: ComposerDraftWorkspaceTransferRequest,
): boolean {
  if (!pendingRequest) {
    return false;
  }
  const matches =
    getWorkspaceKey(pendingRequest.sourceWorkspacePath, pendingRequest.sourceWorkspaceIdentity) ===
      getWorkspaceKey(transition.sourceWorkspacePath, transition.sourceWorkspaceIdentity) &&
    getWorkspaceKey(pendingRequest.targetWorkspacePath, pendingRequest.targetWorkspaceIdentity) ===
      getWorkspaceKey(transition.targetWorkspacePath, transition.targetWorkspaceIdentity);
  if (matches) {
    pendingRequest = null;
  }
  return matches;
}

export function clearV4ComposerDraftWorkspaceTransferRequest(): void {
  pendingRequest = null;
}
