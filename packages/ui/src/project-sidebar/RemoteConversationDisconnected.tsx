import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteProjectConnectionPresentation } from "@/project-sidebar/useRemoteProjectConnectionPresentation.js";
import { RemoteConnectionStateIcon } from "@/remote-connection/RemoteConnectionStateIcon.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface Scope {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
}

export function RemoteConversationBanner(scope: Scope) {
  const { intl } = useZCodeIntl();
  const { presentation, busy, reconnect, tab, deviceName, error } =
    useRemoteProjectConnectionPresentation(scope);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div
      role="status"
      data-testid="remote-conversation-banner"
      data-connection-state={presentation.status}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-3 p-3 text-ui-sm",
        presentation.surface,
        presentation.foreground,
      )}
    >
      <RemoteConnectionStateIcon presentation={presentation} />
      <div className="min-w-0 flex-1">
        <p className={cn("font-medium", presentation.tone === "neutral" && "text-foreground")}>
          {intl.formatMessage({ id: presentation.messageId })}
        </p>
        <p>
          {presentation.reasonText ??
            intl.formatMessage(
              { id: presentation.reason?.reasonId ?? "remote.conversation.unavailable" },
              presentation.reason?.values,
            )}
        </p>
        <p>{intl.formatMessage({ id: "remote.conversation.tasksContinue" })}</p>
      </div>
      <div className="ml-auto flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
          {intl.formatMessage({ id: "remote.error.details" })}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            void reconnect();
          }}
        >
          {intl.formatMessage({ id: "remote.conversation.reconnect" })}
        </Button>
      </div>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{deviceName}</DialogTitle>
            <DialogDescription>{scope.workspacePath}</DialogDescription>
          </DialogHeader>
          {tab ? (
            <RemoteProjectConnectionDetails
              tab={tab}
              deviceName={deviceName}
              presentation={presentation}
              error={error}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 冷态不读取远端数据；草稿只读既有持久化，离线页面没有提交或排队处理器。 */
export function RemoteConversationDisconnected(scope: Scope) {
  const { intl } = useZCodeIntl();
  const clientNamespace = useComposerClientNamespace();
  const projectId = useZCodeSessionStore(
    (state) =>
      state.workspaces[scope.workspaceIdentity?.trim() || scope.workspacePath]?.draftProjectId,
  );
  const draftScope =
    projectId !== undefined
      ? resolveComposerScope(projectId, scope.workspaceIdentity, clientNamespace)
      : (readComposerWorkspaceScope(
          scope.workspacePath,
          scope.workspaceIdentity,
          clientNamespace,
        ) ?? resolveComposerScope(null, scope.workspaceIdentity, clientNamespace));
  const draft = readV4ComposerDraft(
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.sessionId ?? V4_DRAFT_SCOPE_ROOT,
    draftScope,
  );
  const reason = intl.formatMessage({ id: "remote.conversation.sendUnavailable" });
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-testid="remote-conversation-unavailable"
    >
      <RemoteConversationBanner {...scope} />
      <div className="flex min-h-32 flex-1 items-center justify-center p-6 text-center text-ui-base text-remote-foreground-muted">
        {intl.formatMessage({ id: "remote.conversation.placeholder" })}
      </div>
      <div className="m-3 rounded-xl border border-input-border bg-input p-3">
        <textarea
          readOnly
          value={draft?.text ?? ""}
          placeholder={reason}
          aria-label={intl.formatMessage({ id: "remote.conversation.draft" })}
          className="min-h-20 w-full resize-none bg-transparent text-ui-base text-foreground outline-none max-md:text-mobile-input-safe"
        />
        <div className="flex items-center justify-end gap-2 text-ui-sm text-remote-foreground-muted">
          <span>{reason}</span>
          <Button disabled>{intl.formatMessage({ id: "chat.send" })}</Button>
        </div>
      </div>
    </div>
  );
}
