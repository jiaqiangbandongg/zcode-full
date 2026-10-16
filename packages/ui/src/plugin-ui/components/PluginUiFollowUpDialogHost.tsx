import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatPluginDisplayName } from "../domain/pluginDisplayName.js";
import {
  getCurrentPluginUiFollowUpRequest,
  resolvePluginUiFollowUpRequest,
  subscribePluginUiFollowUpRequests,
} from "../app/pluginUiFollowUpDialogStore.js";

export const TID_PLUGIN_UI_FOLLOW_UP_DIALOG = "plugin-ui-follow-up-dialog";
export const TID_PLUGIN_UI_FOLLOW_UP_TEXT = "plugin-ui-follow-up-text";
export const TID_PLUGIN_UI_FOLLOW_UP_SEND = "plugin-ui-follow-up-send";

/**
 * 无用户手势时插件代发消息的确认框。prompt 可编辑；挂在 RootShell，与 ConfirmDialogHost 并列。
 */
export function PluginUiFollowUpDialogHost() {
  const { intl } = useZCodeIntl();
  const request = useSyncExternalStore(
    subscribePluginUiFollowUpRequests,
    getCurrentPluginUiFollowUpRequest,
    () => null,
  );
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setDraft(request?.prompt ?? "");
  }, [request?.requestId, request?.prompt]);
  if (!request) return null;
  const name = formatPluginDisplayName(request.pluginId);
  const cancel = () => resolvePluginUiFollowUpRequest(request.requestId, null);
  const send = () => resolvePluginUiFollowUpRequest(request.requestId, draft);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : cancel())}>
      <DialogContent
        className="max-w-xl overflow-hidden rounded-2xl p-0"
        data-testid={TID_PLUGIN_UI_FOLLOW_UP_DIALOG}
      >
        <div className="flex min-w-0 flex-col gap-6 p-6">
          <DialogHeader className="space-y-2">
            <DialogTitle>{intl.formatMessage({ id: "pluginUi.followUp.title" })}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "pluginUi.followUp.description" }, { name })}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            data-testid={TID_PLUGIN_UI_FOLLOW_UP_TEXT}
            value={draft}
            rows={5}
            onChange={(event) => setDraft(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancel}>
              {intl.formatMessage({ id: "pluginUi.followUp.cancel" })}
            </Button>
            <Button
              type="button"
              data-testid={TID_PLUGIN_UI_FOLLOW_UP_SEND}
              disabled={!draft.trim()}
              onClick={send}
            >
              {intl.formatMessage({ id: "pluginUi.followUp.send" })}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
