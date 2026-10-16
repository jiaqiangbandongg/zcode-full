import { BrowserPermissionIcon } from "@/browser-use/BrowserPermissionIcon.js";
import { BROWSER_PERMISSION_CAPABILITIES } from "@/browser-use/browserPermissionCapabilities.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useBrowserSitePermissions } from "@/hooks/useBrowserSitePermissions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 站点权限设置标签页：数据源为 main 站点权限 store，「仅本次」临时态不展示。 */
export function BrowserSitePermissionsPage({
  origin,
  isVisible,
}: {
  origin: string;
  isVisible: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `browser.permission.${id}` });
  const { states, error: readError, refresh, supported, write, setPermission, reset, retryWrite } =
    useBrowserSitePermissions(origin, isVisible);
  const busy = write.status === "pending";
  const notice = write.status === "succeeded" ? (write.operation.kind === "reset" ? "resetDone" : "saved") : null;
  return (
    <div
      className="h-full min-h-0 overflow-auto bg-background text-foreground"
      data-testid="browser-site-permissions"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        <h1 className="break-all text-ui-xl font-medium">{origin}</h1>
        {!supported ? (
          <p>{t("unsupported")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-ui-lg font-medium">{t("settings")}</h2>
              <Button
                variant="outline"
                disabled={busy || !states}
                data-testid="browser-permission-reset"
                onClick={() => void reset()}
              >
                {t("reset")}
              </Button>
            </div>
            <div className="flex flex-col gap-4" aria-busy={busy}>
              {BROWSER_PERMISSION_CAPABILITIES.map((capability) => {
                const persisted = states?.[capability.key];
                const setting = persisted === "allow" ? "allow" : persisted === "deny" ? "block" : "ask";
                return (
                  <div
                    key={capability.key}
                    className="flex flex-wrap items-center justify-between gap-3"
                    data-permission-key={capability.key}
                  >
                    {/* 窄栏给名称保留可读宽度，让控件换行，避免下拉框把英文挤成逐字断行。 */}
                    <div className="flex min-w-40 max-w-full flex-1 items-center gap-3">
                      <BrowserPermissionIcon capability={capability.iconKey} />
                      <div className="min-w-0 text-ui-base break-words">
                        {intl.formatMessage({ id: capability.labelId })}
                      </div>
                    </div>
                    <Select
                      value={setting}
                      disabled={busy}
                      onValueChange={(next) =>
                        void setPermission(capability.key, next as "ask" | "allow" | "block")
                      }
                    >
                      <SelectTrigger
                        className="w-44 max-w-full shrink-0"
                        aria-label={intl.formatMessage({ id: capability.labelId })}
                        data-testid={`site-permission-setting-${encodeURIComponent(capability.key)}`}
                        data-permission-setting={setting}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          [
                            ["ask", "stateAsk"],
                            ["allow", "stateAllow"],
                            ["block", "stateDeny"],
                          ] as const
                        ).map(([option, labelId]) => (
                          <SelectItem
                            key={option}
                            value={option}
                            data-testid={`site-permission-option-${option}`}
                          >
                            {t(labelId)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            {notice && (
              <p
                role="status"
                className="text-ui-sm text-foreground-subtle"
                data-testid={
                  notice === "resetDone" ? "browser-permission-reset-done" : "browser-permission-saved"
                }
              >
                {t(notice)}
              </p>
            )}
            {write.status === "failed" && (
              <div role="alert" className="text-ui-sm text-destructive">
                {t(write.operation.kind === "reset" ? "resetError" : "saveError")}{" "}
                <Button variant="ghost" onClick={() => void retryWrite()}>
                  {t("retry")}
                </Button>
              </div>
            )}
            {readError && (
              <div role="alert" className="text-ui-sm text-destructive">
                {t("readError")}{" "}
                <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
                  {t("retry")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
