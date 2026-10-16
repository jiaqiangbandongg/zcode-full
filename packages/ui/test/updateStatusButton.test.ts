import { describe, expect, it } from "vitest";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateStatusButton } from "@/UpdateStatusButton.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateStatusDialogPhase,
} from "@/updateStatusModel.js";
import {
  formatUpdateReleaseDate,
  getLocalizedUpdateReleaseNotes,
} from "@/updateReleaseNotes.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";

const noopPlatform = {
  openExternal: () => undefined,
  downloadUpdate: async () => undefined,
  cancelUpdateDownload: async () => undefined,
  getAutoUpdatePreferences: async () => ({
    autoDownloadAndInstallUpdates: false,
  }),
  setAutoDownloadAndInstallUpdates: async () => undefined,
  skipUpdateVersion: async () => undefined,
  quitAndInstallUpdate: async () => undefined,
} as unknown as IPlatformService;

const noopServices = {
  settingService: {
    get: async () => ({}),
    update: async () => undefined,
  },
} as unknown as IServiceAccessor;

function renderUpdateStatusButton(
  updateState: UpdateStatePayload | null,
  version: string | null = null,
) {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        ServiceProvider,
        { services: noopServices },
        createElement(
          PlatformProvider,
          { platform: noopPlatform },
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(UpdateStatusButton, {
              platform: noopPlatform,
              version,
              updateState,
            }),
          ),
        ),
      ),
    ),
  );
}

const testIntl: IntlInstance = {
  formatMessage({ id }, values) {
    if (values?.version) {
      return `更新 ${values.version}`;
    }

    return id;
  },
};

function updateStatusDialogElementContainsText(
  phase: UpdateStatusDialogPhase,
  text: string,
  isUpdateActionPending = false,
) {
  return elementContainsText(
    renderUpdateStatusDialogElement(
      phase,
      isUpdateActionPending,
    ),
    text,
  );
}

function updateStatusDialogElementContainsPropText(
  phase: UpdateStatusDialogPhase,
  text: string,
  edgeToEdge = false,
) {
  return elementContainsPropText(
    renderUpdateStatusDialogElement(phase, false, null, edgeToEdge),
    text,
  );
}

function updateStatusDialogElementContainsMatchingPropText(
  phase: UpdateStatusDialogPhase,
  matcher: (className: string) => boolean,
  edgeToEdge = false,
) {
  return elementContainsMatchingElement(
    renderUpdateStatusDialogElement(phase, false, null, edgeToEdge),
    (_type, props) =>
      typeof props.className === "string" && matcher(props.className),
  );
}

function updateStatusDialogUsesStackedReleaseDate(
  phase: UpdateStatusDialogPhase,
) {
  return elementContainsMatchingElement(
    renderUpdateStatusDialogElement(phase, false, "2026-07-09"),
    (type, props) =>
      type === "div" &&
      typeof props.className === "string" &&
      props.className.includes("inline-flex") &&
      props.className.includes("max-w-full") &&
      !props.className.includes("ml-auto") &&
      !props.className.includes("text-right") &&
      elementContainsText(props.children, "2026-07-09"),
  );
}

function updateStatusDialogUsesCenteredLogoTitleLayout(
  phase: UpdateStatusDialogPhase,
) {
  return elementContainsMatchingElement(
    renderUpdateStatusDialogElement(phase, false, "2026-07-09"),
    (type, props) =>
      type === "div" &&
      typeof props.className === "string" &&
      props.className.includes("flex") &&
      props.className.includes("items-center") &&
      elementContainsMatchingElement(
        props.children,
        (childType, childProps) =>
          childType === "img" &&
          typeof childProps.className === "string" &&
          childProps.className.includes("size-12"),
      ) &&
      elementContainsText(props.children, "2026-07-09"),
  );
}

function updateStatusDialogUsesMacDockProductLogo(
  phase: UpdateStatusDialogPhase,
) {
  return elementContainsMatchingElement(
    renderUpdateStatusDialogElement(phase),
    (type, props) =>
      type === "img" &&
      typeof props.src === "string" &&
      props.src.includes("icon_512@2x.png") &&
      props.alt === "" &&
      props.draggable === false &&
      typeof props.className === "string" &&
      props.className.includes("size-12") &&
      props.className.includes("-ml-[5px]") &&
      props.className.includes("shadow-none") &&
      props.className.includes("drop-shadow-none"),
  );
}

function countUpdateStatusDialogElementPropText(
  phase: UpdateStatusDialogPhase,
  text: string,
  isUpdateActionPending = false,
) {
  return countElementPropText(
    renderUpdateStatusDialogElement(
      phase,
      isUpdateActionPending,
    ),
    text,
  );
}

function countUpdateStatusDialogBooleanProp(
  phase: UpdateStatusDialogPhase,
  propName: string,
  isUpdateActionPending = false,
  edgeToEdge = false,
) {
  return countElementBooleanProp(
    renderUpdateStatusDialogElement(
      phase,
      isUpdateActionPending,
      null,
      edgeToEdge,
    ),
    propName,
  );
}

function countUpdateStatusDialogPropValue(
  phase: UpdateStatusDialogPhase,
  propName: string,
  propValue: unknown,
) {
  return countElementPropValue(
    renderUpdateStatusDialogElement(phase),
    propName,
    propValue,
  );
}

function renderUpdateStatusDialogElement(
  phase: UpdateStatusDialogPhase,
  isUpdateActionPending = false,
  releaseDateLabel: string | null = null,
  edgeToEdge = false,
) {
  return UpdateStatusDialog({
    autoDownloadAndInstallUpdates: false,
    displayVersion: "3.3.3",
    edgeToEdge,
    intl: testIntl,
    isUpdateActionPending,
    localizedUpdateReleaseNotes: {
      markdown: "Visible before downloading",
      title: "Release v3.3.3",
    },
    onAutoDownloadAndInstallUpdatesChange: async () => undefined,
    onCancelDownload: async () => undefined,
    onDownloadUpdate: async () => undefined,
    onOpenChange: () => undefined,
    onOpenReleaseNotesExternalUrl: () => undefined,
    onRestartUpdate: async () => undefined,
    onSkipUpdate: async () => undefined,
    open: true,
    phase,
    progressLabel: "4.2MB / 10.0MB",
    progressValue: 42,
    releaseDateLabel,
    skippableVersion: phase === "downloaded" ? null : "3.3.3",
  });
}

function elementContainsText(node: unknown, text: string): boolean {
  if (node == null || typeof node === "boolean") {
    return false;
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node).includes(text);
  }

  if (Array.isArray(node)) {
    return node.some((child) => elementContainsText(child, text));
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: unknown };
    return elementContainsText(props.children, text);
  }

  return false;
}

function countElementPropText(node: unknown, text: string): number {
  if (node == null || typeof node === "boolean") {
    return 0;
  }

  if (Array.isArray(node)) {
    return node.reduce(
      (count, child) => count + countElementPropText(child, text),
      0,
    );
  }

  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const matchingPropCount = Object.entries(props).filter(
      ([key, value]) =>
        key !== "children" &&
        typeof value === "string" &&
        value.includes(text),
    ).length;

    return matchingPropCount + countElementPropText(props.children, text);
  }

  return 0;
}

function countElementBooleanProp(node: unknown, propName: string): number {
  if (node == null || typeof node === "boolean") {
    return 0;
  }

  if (Array.isArray(node)) {
    return node.reduce(
      (count, child) => count + countElementBooleanProp(child, propName),
      0,
    );
  }

  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const selfCount = props[propName] === true ? 1 : 0;
    return selfCount + countElementBooleanProp(props.children, propName);
  }

  return 0;
}

function countElementPropValue(
  node: unknown,
  propName: string,
  propValue: unknown,
): number {
  if (node == null || typeof node === "boolean") {
    return 0;
  }

  if (Array.isArray(node)) {
    return node.reduce(
      (count, child) => count + countElementPropValue(child, propName, propValue),
      0,
    );
  }

  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const selfCount = props[propName] === propValue ? 1 : 0;
    return selfCount + countElementPropValue(props.children, propName, propValue);
  }

  return 0;
}

function elementContainsPropText(node: unknown, text: string): boolean {
  if (node == null || typeof node === "boolean") {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some((child) => elementContainsPropText(child, text));
  }

  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const hasMatchingStringProp = Object.entries(props).some(
      ([key, value]) =>
        key !== "children" &&
        typeof value === "string" &&
        value.includes(text),
    );

    return (
      hasMatchingStringProp || elementContainsPropText(props.children, text)
    );
  }

  return false;
}

function elementContainsMatchingElement(
  node: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): boolean {
  if (node == null || typeof node === "boolean") {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some((child) =>
      elementContainsMatchingElement(child, predicate),
    );
  }

  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    return (
      predicate(node.type, props) ||
      elementContainsMatchingElement(props.children, predicate)
    );
  }

  return false;
}

describe("UpdateStatusButton release notes", () => {
  it("selects release notes by current locale", () => {
    const payload = {
      version: "3.1.3",
      title: "Release v3.1.3",
      markdown: "- 默认说明",
      releaseNotesByLocale: {
        "zh-CN": {
          title: "ZCode v3.1.3",
          markdown: "- 中文说明",
        },
        "en-US": {
          title: "ZCode v3.1.3",
          markdown: "- English notes",
        },
      },
    };

    expect(getLocalizedUpdateReleaseNotes(payload, "en-US")).toEqual({
      title: "ZCode v3.1.3",
      markdown: "- English notes",
    });
    expect(getLocalizedUpdateReleaseNotes(payload, "zh-CN")).toEqual({
      title: "ZCode v3.1.3",
      markdown: "- 中文说明",
    });
  });

  it("falls back to default release notes for legacy update feeds", () => {
    expect(
      getLocalizedUpdateReleaseNotes(
        {
          version: "3.1.3",
          title: "Release v3.1.3",
          markdown: "- default notes",
        },
        "en-US",
      ),
    ).toEqual({
      title: "Release v3.1.3",
      markdown: "- default notes",
    });
  });

  it("keeps default release notes for zh-CN when only an english sibling exists", () => {
    expect(
      getLocalizedUpdateReleaseNotes(
        {
          version: "3.1.4",
          title: "Release v3.1.4",
          markdown: "- 中文说明",
          releaseNotesByLocale: {
            "en-US": {
              title: "Release v3.1.4",
              markdown: "- English notes",
            },
          },
        },
        "zh-CN",
      ),
    ).toEqual({
      title: "Release v3.1.4",
      markdown: "- 中文说明",
    });
  });

  it("formats release dates by locale", () => {
    expect(formatUpdateReleaseDate("2026-06-23T13:48:54.438Z", "en-US")).toBe(
      "June 23, 2026",
    );
    expect(formatUpdateReleaseDate("2026-06-23T13:48:54.438Z", "zh-CN")).toBe(
      "2026年6月23日",
    );
  });

  it("formats UTC midnight release dates without shifting to local previous day", () => {
    expect(formatUpdateReleaseDate("2026-04-15T00:00:00.000Z", "en-US")).toBe(
      "April 15, 2026",
    );
  });

  it("shows dialog release date as a plain date without suffix text", () => {
    const formattedDate = formatUpdateReleaseDate(
      "2026-06-23T13:48:54.438Z",
      "zh-CN",
    );

    expect(zhCN["updateDialog.releaseDate"].replace("{date}", formattedDate!)).toBe(
      "2026年6月23日",
    );
  });

  it("labels the available update action as download update", () => {
    expect(zhCN["updateDialog.downloadAndUpdate"]).toBe("下载更新");
    expect(enUS["updateDialog.downloadAndUpdate"]).toBe("Download update");
  });

  it("shows the auto download checkbox before downloading", () => {
    expect(
      updateStatusDialogElementContainsText(
        "before-download",
        "updateDialog.autoDownloadAndInstall",
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsText(
        "downloading",
        "updateDialog.autoDownloadAndInstall",
      ),
    ).toBe(false);
  });

  it("omits release notes from the update dialog", () => {
    expect(
      updateStatusDialogElementContainsText(
        "before-download",
        "Visible before downloading",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText(
        "downloading",
        "Visible before downloading",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText(
        "downloaded",
        "Visible before downloading",
      ),
    ).toBe(false);
  });

  it("omits update dialog title descriptions", () => {
    expect(
      updateStatusDialogElementContainsText(
        "before-download",
        "updateDialog.availableDescription",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText(
        "downloading",
        "updateDialog.downloadingDescription",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText(
        "downloaded",
        "updateDialog.readyDescription",
      ),
    ).toBe(false);
  });

  it.each<UpdateStatusDialogPhase>([
    "before-download",
    "downloading",
    "downloaded",
  ])("shows the macOS Dock product logo in the %s title", (phase) => {
    expect(updateStatusDialogUsesMacDockProductLogo(phase)).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(phase, "scale-105"),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsPropText(phase, "rounded-xl"),
    ).toBe(false);
  });

  it.each<UpdateStatusDialogPhase>([
    "before-download",
    "downloading",
    "downloaded",
  ])("centers the %s title metadata beside the logo", (phase) => {
    expect(updateStatusDialogUsesStackedReleaseDate(phase)).toBe(true);
    expect(updateStatusDialogUsesCenteredLogoTitleLayout(phase)).toBe(true);
  });

  it("uses standard dialog interior padding in the update dialog", () => {
    expect(
      updateStatusDialogElementContainsPropText("before-download", "p-5"),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText("before-download", "px-5"),
    ).toBe(false);
  });

  it("uses theme color treatment for downloading progress", () => {
    expect(
      updateStatusDialogElementContainsPropText("downloading", "bg-primary"),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText("downloading", "bg-success"),
    ).toBe(false);
  });

  it("shows download size text in a button-aligned progress row", () => {
    expect(
      updateStatusDialogElementContainsText("downloading", "4.2MB / 10.0MB"),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText("downloading", "ml-2"),
    ).toBe(false);
  });

  it("uses the same secondary treatment for skip and later actions", () => {
    expect(countUpdateStatusDialogPropValue("before-download", "variant", "secondary")).toBe(2);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "text-foreground-subtle",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsPropText("before-download", "-ml-2"),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsPropText("before-download", "ml-2"),
    ).toBe(false);
  });

  it("uses standard control height across the update dialog actions", () => {
    expect(
      countUpdateStatusDialogElementPropText("before-download", "h-9"),
    ).toBe(3);
  });

  it("hides skip and later actions while downloading", () => {
    expect(
      updateStatusDialogElementContainsText(
        "downloading",
        "updateDialog.skipVersion",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText("downloading", "updateDialog.later"),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText(
        "downloading",
        "updateDialog.cancelDownload",
      ),
    ).toBe(true);
    expect(countUpdateStatusDialogElementPropText("downloading", "h-9")).toBe(
      1,
    );
    expect(
      updateStatusDialogElementContainsPropText("downloading", "-mt-2"),
    ).toBe(true);
  });

  it("shows later and restart actions after download finishes", () => {
    expect(
      updateStatusDialogElementContainsText(
        "downloaded",
        "updateDialog.skipVersion",
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsText("downloaded", "updateDialog.later"),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsText(
        "downloaded",
        "updateDialog.restartToUpdate",
      ),
    ).toBe(true);
    expect(countUpdateStatusDialogElementPropText("downloaded", "h-9")).toBe(
      2,
    );
  });

  it("disables visible update actions while a command is in flight", () => {
    expect(
      countUpdateStatusDialogBooleanProp("before-download", "disabled", true),
    ).toBe(4);
    expect(
      countUpdateStatusDialogBooleanProp("downloading", "disabled", true),
    ).toBe(1);
    expect(
      countUpdateStatusDialogBooleanProp("downloaded", "disabled", true),
    ).toBe(2);
  });

  it("uses the standard large desktop dialog width", () => {
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "max-w-[calc(100vw-2rem)]",
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "sm:max-w-lg",
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "sm:max-w-[28rem]",
      ),
    ).toBe(false);
  });

  it("can remove the dialog shell for the standalone update window", () => {
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "border-0",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "shadow-none",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "max-w-none",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "data-open:animate-in",
        true,
      ),
    ).toBe(false);
  });

  it("keeps desktop footer action layout in the standalone update window", () => {
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "flex-row items-center gap-3",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "justify-between",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "w-auto flex-row justify-end",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "downloading",
        "justify-end",
        true,
      ),
    ).toBe(true);
  });

  it("does not reserve an empty content row in the standalone update window before download", () => {
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "grid-rows-[auto_auto]",
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsPropText(
        "before-download",
        "grid-rows-[auto_minmax(0,1fr)_auto]",
        true,
      ),
    ).toBe(false);
    expect(
      updateStatusDialogElementContainsPropText(
        "downloading",
        "grid-rows-[auto_minmax(0,1fr)_auto]",
        true,
      ),
    ).toBe(true);
  });

  it("keeps the standalone update window titlebar area draggable", () => {
    expect(
      updateStatusDialogElementContainsMatchingPropText(
        "before-download",
        (className) =>
          className.includes("p-5") &&
          className.includes("pt-10") &&
          !className.includes("[app-region:no-drag]"),
        true,
      ),
    ).toBe(true);
    expect(
      updateStatusDialogElementContainsMatchingPropText(
        "before-download",
        (className) =>
          className.includes("items-center") &&
          className.includes("[app-region:no-drag]"),
        true,
      ),
    ).toBe(true);
  });

  it("uses the original color treatment whenever the main update entry is visible", () => {
    const availableHtml = renderUpdateStatusButton({
      kind: "update-available",
      version: "3.3.3",
      channel: "stable",
    } as UpdateStatePayload);
    const downloadingHtml = renderUpdateStatusButton({
      kind: "download-progress",
      version: "3.3.3",
      progress: "42",
      channel: "stable",
    } as UpdateStatePayload);
    const downloadedHtml = renderUpdateStatusButton({
      kind: "update-downloaded",
      version: "3.3.3",
      channel: "stable",
    } as UpdateStatePayload);

    expect(availableHtml).toContain("bg-success");
    expect(availableHtml).toContain("text-success-foreground");
    expect(availableHtml).toContain("topoverlayer:w-auto");
    expect(availableHtml).toContain("h-auto");
    expect(availableHtml).toContain("min-h-5");
    expect(availableHtml).toContain("py-0.5");
    expect(availableHtml).toContain("font-medium");
    expect(availableHtml).toContain("text-ui-xs");
    expect(availableHtml).not.toContain("text-ui-sm");
    expect(availableHtml).not.toContain("text-ui-base");
    expect(downloadingHtml).toContain("bg-success");
    expect(downloadingHtml).toContain("text-success-foreground");
    expect(downloadingHtml).toContain("animate-spin");
    expect(downloadingHtml).not.toContain('disabled=""');
    expect(downloadingHtml).not.toContain("下载中");
    expect(downloadingHtml).not.toContain("topoverlayer:w-auto");
    expect(downloadingHtml).not.toContain("topoverlayer:hidden");
    expect(downloadedHtml).toContain("bg-success");
    expect(downloadedHtml).toContain("text-success-foreground");
    expect(downloadedHtml).toContain("topoverlayer:w-auto");
  });

  it("keeps the downloading entry visible when progress state omits version", () => {
    const html = renderUpdateStatusButton({
      kind: "download-progress",
      progress: "42",
      channel: "stable",
    } as UpdateStatePayload);

    // Bugfix: download-progress.version 是协议可选字段。不能因为某一帧缺少版本号
    // 就把更新入口卸载，否则用户打开的下载弹窗会跟着消失。
    expect(html).toContain("bg-success");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("topoverlayer:w-auto");
  });

  it("derives downloading dialog model from state kind instead of version", () => {
    const model = deriveUpdateStatusViewModel({
      legacyReadyVersion: "3.3.2",
      updateState: {
        kind: "download-progress",
        enabled: false,
        progress: "42",
        transferredBytes: 4.2 * 1024 * 1024,
        totalBytes: 10 * 1024 * 1024,
      },
    });

    expect(model.dialogPhase).toBe("downloading");
    expect(model.displayVersion).toBe("…");
    expect(model.progressLabel).toBe("4.2MB / 10.0MB");
    expect(model.progressValue).toBe(42);
    expect(model.skippableVersion).toBe(null);
  });

  it("keeps action completion rules in the update status model", () => {
    expect(
      isUpdateActionCompleted("download", { kind: "checking", enabled: true }),
    ).toBe(false);
    expect(
      isUpdateActionCompleted("download", { kind: "idle", enabled: true }),
    ).toBe(false);
    expect(
      isUpdateActionCompleted("download", {
        kind: "download-progress",
        enabled: false,
        progress: "1",
      }),
    ).toBe(true);
    expect(
      isUpdateActionCompleted("cancel", {
        kind: "download-progress",
        enabled: false,
        progress: "1",
      }),
    ).toBe(false);
    expect(
      isUpdateActionCompleted("skip", { kind: "idle", enabled: true }),
    ).toBe(true);
  });

  it("ignores stale legacy ready version after state reports idle", () => {
    const html = renderUpdateStatusButton(
      { kind: "idle", enabled: true },
      "3.3.2",
    );

    // Bugfix: main 侧 staging error 后会广播 idle，但旧 UpdateReady 缓存仍可能残留。
    // UI 此时不能继续展示“重启以更新”，否则点击只会命中一个已失效的安装上下文。
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain("updateReady.shortTitle");
  });

  it("keeps legacy ready version when no update state API exists", () => {
    const html = renderUpdateStatusButton(null, "3.3.2");

    // 平滑迁移：旧包只会发 UpdateReady，不一定有持续状态流。
    // 只有新状态明确同步成 idle/error/checking 后，才清掉 legacy ready。
    expect(html).toContain("bg-success");
    expect(html).toContain("topoverlayer:w-auto");
  });
});
