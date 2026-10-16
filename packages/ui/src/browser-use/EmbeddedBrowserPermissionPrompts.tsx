import { useEffect, useMemo, useState } from "react";
import { MonitorUp, Paperclip, ShieldAlert, Usb, X } from "lucide-react";
import {
  TID_BROWSER_PERMISSION_ALLOW_ALWAYS,
  TID_BROWSER_PERMISSION_ALLOW_ONCE,
  TID_BROWSER_PERMISSION_DENY,
  TID_BROWSER_PERMISSION_DISMISS,
  TID_BROWSER_PERMISSION_PROMPTS,
  type EmbeddedBrowserPermissionPromptEvent,
  type EmbeddedBrowserPermissionResolution,
} from "@zcode/shared";
import { BrowserPermissionIcon } from "@/browser-use/BrowserPermissionIcon.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { logger } from "@/logger.js";
import { useEmbeddedBrowserPermissionStore } from "@/store/embeddedBrowserPermissionStore.js";

/**
 * 内置浏览器权限弹窗层（spec：docs/browser-use/2026-10-08-embedded-browser-permission-governance-spec.md）。
 * permission → Chrome 式锚定气泡（地址栏下方左侧，自动弹出；卡片为 origin 标题 + ✕ 关闭 +
 * 能力图标列表 + 竖排三胶囊：访问此网站时允许（持久）/ 仅本次允许 / 不允许（本次拒绝不记忆）；
 * 不做「永久阻止」——误点后站点异常难以自愈，持久 deny 只保留在站点权限设置里管理）；
 * screen-share / device → Dialog 选择器（源按「整个屏幕 / 窗口」分组）。
 * 取消与超时统一由 main 结算，renderer 只回传决策。
 */

const MEDIA_LABEL: Record<string, string> = {
  video: "browser.permission.mediaVideo",
  audio: "browser.permission.mediaAudio",
};

const PERMISSION_LABEL: Record<string, string> = {
  media: "browser.permission.media",
  "clipboard-read": "browser.permission.clipboardRead",
  geolocation: "browser.permission.geolocation",
  notifications: "browser.permission.notifications",
  midi: "browser.permission.midi",
  midiSysex: "browser.permission.midi",
  "idle-detection": "browser.permission.idleDetection",
  "speaker-selection": "browser.permission.speakerSelection",
  "window-management": "browser.permission.windowManagement",
  "storage-access": "browser.permission.storageAccess",
  "top-level-storage-access": "browser.permission.storageAccess",
  keyboardLock: "browser.permission.keyboardLock",
  fileSystem: "browser.permission.fileSystem",
  "select-hid-device": "browser.permission.deviceHid",
  "select-usb-device": "browser.permission.deviceUsb",
  "select-serial-port": "browser.permission.deviceSerial",
  "select-bluetooth-device": "browser.permission.deviceBluetooth",
};

function permissionLabelId(permission: string, mediaTypes?: string[]): string {
  if (permission === "media" && mediaTypes && mediaTypes.length > 0) {
    const ids = mediaTypes.map((type) => MEDIA_LABEL[type]).filter(Boolean);
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1) return "browser.permission.mediaBoth";
  }
  return PERMISSION_LABEL[permission] ?? "browser.permission.unknownCapability";
}

/** 气泡能力列表：media 按 mediaTypes 拆成摄像头/麦克风独立行，其余一类一行。 */
function promptCapabilities(
  prompt: Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }>,
): { key: string; labelId: string }[] {
  if (prompt.permission === "media") {
    const types = prompt.mediaTypes?.length ? prompt.mediaTypes : ["video", "audio"];
    return types.map((type) => ({
      key: type === "video" ? "camera" : "microphone",
      labelId: MEDIA_LABEL[type] ?? "browser.permission.media",
    }));
  }
  return [{ key: prompt.permission, labelId: permissionLabelId(prompt.permission) }];
}

function promptIcon(event: EmbeddedBrowserPermissionPromptEvent) {
  if (event.kind === "screen-share") return <MonitorUp className="size-4 shrink-0" />;
  if (event.kind === "device") return <Usb className="size-4 shrink-0" />;
  if (event.permission === "clipboard-read") return <Paperclip className="size-4 shrink-0" />;
  return <ShieldAlert className="size-4 shrink-0" />;
}

/**
 * guestWebContentsId 是当前 tab 的 guest 身份：permission 请求带归属 id 且不匹配
 * 当前 tab 时不在本 tab 渲染（后台 tab 的请求不显示在当前 tab，避免误批准）。
 * 当前 tab 无 guest（空 tab）时任何带归属的请求都不属于它，同样不渲染；
 * 请求缺归属 id（device/screen-share 等无 tab 锚定语义的弹窗）兜底渲染，
 * 气泡正文始终展示 origin 供用户确认来源。
 */
export function EmbeddedBrowserPermissionPrompts({
  guestWebContentsId,
}: {
  guestWebContentsId?: number;
}) {
  const platform = usePlatform();
  const {
    intl: { formatMessage },
  } = useZCodeIntl();
  const prompts = useEmbeddedBrowserPermissionStore((state) => state.prompts);
  const receivePrompt = useEmbeddedBrowserPermissionStore((state) => state.receivePrompt);
  const dropPrompt = useEmbeddedBrowserPermissionStore((state) => state.dropPrompt);
  const [selection, setSelection] = useState<Record<string, string>>({});

  useEffect(() => {
    // main 侧超时结算后不会主动通知 renderer；渲染层对超时同样按 20s 出队兜底，
    // 避免条目残留（下次同请求是新的 requestId，不受影响）。
    const disposers = prompts.map((prompt) => {
      const timer = setTimeout(() => dropPrompt(prompt.requestId), 20_000);
      return () => clearTimeout(timer);
    });
    return () => disposers.forEach((dispose) => dispose());
  }, [prompts, dropPrompt]);

  useEffect(() => {
    const dispose = platform.onEmbeddedBrowserPermissionPrompt?.((event) => receivePrompt(event));
    if (!dispose) {
      logger.warn("[embedded-browser-permission] platform prompt subscription unavailable");
      return;
    }
    return dispose;
  }, [platform, receivePrompt]);

  const resolve = (requestId: string, resolution: EmbeddedBrowserPermissionResolution) => {
    platform.resolveEmbeddedBrowserPermissionPrompt?.({ requestId, resolution });
    dropPrompt(requestId);
  };

  const permissionPrompts = useMemo(
    () =>
      prompts.filter(
        (prompt): prompt is Extract<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind === "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );
  // device 弹窗与 permission 同样按 guest 归属过滤（serial/蓝牙可取到归属；
  // hid/usb 与屏幕共享缺省归属 id 时兜底渲染，正文 origin 标明来源）。
  const selectorPrompts = useMemo(
    () =>
      prompts.filter(
        (
          prompt,
        ): prompt is Exclude<EmbeddedBrowserPermissionPromptEvent, { kind: "permission" }> =>
          prompt.kind !== "permission" &&
          (prompt.guestWebContentsId === undefined ||
            prompt.guestWebContentsId === guestWebContentsId),
      ),
    [prompts, guestWebContentsId],
  );

  return (
    <>
      {permissionPrompts.length > 0 ? (
        <div
          className="pointer-events-none absolute left-3 top-1.5 z-40 flex w-80 max-w-[calc(100%-24px)] flex-col gap-2"
          data-testid={TID_BROWSER_PERMISSION_PROMPTS}
        >
          {permissionPrompts.map((prompt) => (
            <div
              key={prompt.requestId}
              className="pointer-events-auto rounded-xl border border-popover-border bg-popover p-4 shadow-md"
              role="dialog"
              aria-label={formatMessage({ id: "browser.permission.promptAriaLabel" })}
            >
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-ui-lg leading-relaxed font-medium break-words">
                  <span className="text-foreground">{prompt.origin}</span>
                  <span className="text-ui-base text-foreground-subtle">
                    {" "}
                    {formatMessage({ id: "browser.permission.wantsToUse" })}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={formatMessage({ id: "browser.permission.close" })}
                  data-testid={TID_BROWSER_PERMISSION_DISMISS}
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  <X />
                </Button>
              </div>
              <ul className="mt-2 space-y-2">
                {promptCapabilities(prompt).map((capability) => (
                  <li
                    key={capability.key}
                    className="flex items-center gap-2 text-ui-base text-foreground break-all"
                  >
                    <BrowserPermissionIcon capability={capability.key} />
                    {formatMessage({ id: capability.labelId })}
                  </li>
                ))}
              </ul>
              {/* 竖排三胶囊（fix/missing_tool 视觉）：持久允许 / 仅本次允许 / 不允许（不记忆）。
                  不提供「永久阻止」：误点后站点异常难自愈，持久 deny 只在站点权限设置管理。 */}
              <div className="mt-3 flex flex-col gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ALWAYS}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-always" })}
                >
                  {formatMessage({ id: "browser.permission.allowAlways" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_ALLOW_ONCE}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "allow-session" })}
                >
                  {formatMessage({ id: "browser.permission.allowOnce" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid={TID_BROWSER_PERMISSION_DENY}
                  className="h-auto min-h-9 justify-start rounded-full px-4 py-2 text-left whitespace-normal"
                  onClick={() => resolve(prompt.requestId, { action: "dismiss" })}
                >
                  {formatMessage({ id: "browser.permission.denyThisTime" })}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {selectorPrompts.map((prompt) => (
        <Dialog
          key={prompt.requestId}
          open
          onOpenChange={(open) => {
            if (!open) resolve(prompt.requestId, { action: "cancel" });
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {promptIcon(prompt)}
                {prompt.kind === "screen-share"
                  ? formatMessage(
                      { id: "browser.permission.screenShareTitle" },
                      { origin: prompt.origin },
                    )
                  : formatMessage(
                      { id: "browser.permission.deviceTitle" },
                      { origin: prompt.origin },
                    )}
              </DialogTitle>
              <DialogDescription>
                {prompt.kind === "screen-share"
                  ? formatMessage({ id: "browser.permission.screenShareDescription" })
                  : formatMessage({ id: permissionLabelId(prompt.permission) })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {prompt.kind === "screen-share" ? (
                (["screen", "window"] as const).map((group) => {
                  const screens = prompt.screens.filter((screen) => screen.kind === group);
                  if (screens.length === 0) return null;
                  return (
                    <div key={group}>
                      <p className="px-2 pb-1 pt-2 text-ui-xs text-foreground-subtlest">
                        {formatMessage({
                          id:
                            group === "screen"
                              ? "browser.permission.screenGroup.screen"
                              : "browser.permission.screenGroup.window",
                        })}
                      </p>
                      {screens.map((screen) => (
                        <button
                          type="button"
                          key={screen.sourceId}
                          className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                          data-selected={selection[prompt.requestId] === screen.sourceId}
                          onClick={() =>
                            setSelection((current) => ({
                              ...current,
                              [prompt.requestId]: screen.sourceId,
                            }))
                          }
                        >
                          {screen.thumbnailDataUrl ? (
                            <img
                              src={screen.thumbnailDataUrl}
                              alt=""
                              className="h-[45px] w-20 rounded-sm border border-border object-cover"
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                            {screen.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })
              ) : (
                prompt.devices.map((device) => (
                  <button
                    type="button"
                    key={device.deviceId}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-menu-hover data-[selected=true]:bg-selected"
                    data-selected={selection[prompt.requestId] === device.deviceId}
                    onClick={() =>
                      setSelection((current) => ({
                        ...current,
                        [prompt.requestId]: device.deviceId,
                      }))
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui-sm text-foreground">
                        {device.name ?? device.deviceId}
                      </span>
                      {device.vendorId !== undefined || device.serialNumber ? (
                        <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
                          {[
                            device.vendorId !== undefined && device.productId !== undefined
                              ? `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`
                              : undefined,
                            device.serialNumber,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <DialogFooter>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolve(prompt.requestId, { action: "cancel" })}
              >
                {formatMessage({ id: "browser.permission.cancel" })}
              </Button>
              <Button
                size="sm"
                disabled={!selection[prompt.requestId]}
                onClick={() => {
                  const picked = selection[prompt.requestId];
                  if (!picked) return;
                  resolve(
                    prompt.requestId,
                    prompt.kind === "screen-share"
                      ? { action: "share-screen", sourceId: picked }
                      : { action: "select-device", deviceId: picked },
                  );
                }}
              >
                {formatMessage({
                  id:
                    prompt.kind === "screen-share"
                      ? "browser.permission.share"
                      : "browser.permission.connect",
                })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
    </>
  );
}
