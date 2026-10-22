import { useRef } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ProjectFolderTrustRequest {
  roots: string[];
  /** 聊天固定目录创建时展示本次名称；恢复沿用已确认项目的名称。 */
  projectName?: string;
  /** 远程设备名；本地名称在渲染时翻译，避免语言切换后保留旧译文。 */
  deviceLabel?: string;
  restoring: boolean;
  resolve(accepted: boolean): void;
}

export function ProjectFolderTrustDialog({
  request,
  onClosed,
}: {
  request: ProjectFolderTrustRequest;
  onClosed(): void;
}) {
  const { intl } = useZCodeIntl();
  const cancel = useRef<HTMLButtonElement>(null);
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) request.resolve(false);
      }}
    >
      <DialogContent
        data-testid="project-folder-trust-dialog"
        className="max-h-dvh overflow-y-auto sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // 信任必须是明确选择；普通确认框的全局 Enter 会把连续按键误当作授权。
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogTitle className="pr-8 text-ui-lg font-semibold">
          {msg(request.roots.length === 1 ? "trustFolderTitle" : "trustFoldersTitle")}
        </DialogTitle>
        <div className="grid min-w-0 gap-2">
          {request.projectName ? <p className="break-words">{request.projectName}</p> : null}
          <p className="break-words text-foreground-subtle">
            {request.deviceLabel ?? msg("thisComputer")}
          </p>
          <ul className="max-h-48 min-w-0 space-y-2 overflow-y-auto font-mono text-ui-sm select-text">
            {request.roots.map((root) => (
              <li key={root} data-testid="project-folder-trust-path" className="break-all">
                {root}
              </li>
            ))}
          </ul>
        </div>
        <DialogDescription>{msg("trustFoldersDescription")}</DialogDescription>
        <DialogFooter>
          <Button
            ref={cancel}
            variant="secondary"
            data-testid="project-folder-trust-cancel"
            onClick={() => request.resolve(false)}
          >
            {msg("cancel")}
          </Button>
          <Button
            data-testid="project-folder-trust-confirm"
            className="h-auto min-h-7 whitespace-normal"
            onClick={() => request.resolve(true)}
          >
            {msg(request.restoring ? "trustFoldersAndRestore" : "trustFoldersAndCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
