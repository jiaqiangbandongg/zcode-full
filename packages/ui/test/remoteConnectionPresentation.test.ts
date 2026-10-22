import { describe, expect, it } from "vitest";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";

describe("远程连接展示合同", () => {
  it("主动断开覆盖保留的错误和升级门禁", () => {
    expect(
      resolveRemoteConnectionPresentation({
        state: "failed",
        disconnectOrigin: "user",
        errorCode: "source-server-upgrade-required",
      }),
    ).toMatchObject({
      status: "offline",
      shortMessageId: "remote.status.offline",
      tone: "neutral",
      icon: "cloud-off",
      primaryAction: "connect",
    });
  });
});

it.each([
  [{ state: "online", attached: true }, "online", "online", "success", "cloud", "disconnect"],
  [{ state: "online", attached: false }, "connecting", "connecting", "progress", "spinner", "none"],
  [{ state: "bootstrapping" }, "connecting", "connecting", "progress", "spinner", "none"],
  [
    { state: "retrying", recoveryAttempt: 2, recoveryLimit: 3 },
    "connecting",
    "connecting",
    "progress",
    "spinner",
    "none",
  ],
  [
    { state: "updating", errorCode: "source-server-upgrade-required" },
    "connecting",
    "updating",
    "progress",
    "spinner",
    "none",
  ],
  [{ state: "offline" }, "offline", "offline", "neutral", "cloud-off", "connect"],
  [
    { state: "absent", disconnectOrigin: "startup" },
    "offline",
    "offline",
    "neutral",
    "cloud-off",
    "connect",
  ],
  [{ state: "needs-install" }, "pending", "needsInstall", "warning", "cloud-alert", "install"],
  [
    { state: "needs-upgrade", upgradeTarget: "server" },
    "pending",
    "needsUpdate",
    "warning",
    "cloud-alert",
    "update-server",
  ],
  [
    { state: "needs-upgrade", upgradeTarget: "controller" },
    "pending",
    "needsUpdate",
    "warning",
    "cloud-alert",
    "update-desktop",
  ],
  [
    { state: "identity-change-pending" },
    "pending",
    "needsIdentity",
    "warning",
    "cloud-alert",
    "confirm-identity",
  ],
  [
    { state: "failed", credentialsMissing: true },
    "pending",
    "needsCredentials",
    "warning",
    "cloud-alert",
    "credentials",
  ],
  [
    { state: "failed", errorCode: "remote-connection-timeout" },
    "failed",
    "failed",
    "danger",
    "cloud-x",
    "retry",
  ],
  [
    { state: "offline", recoveryBudgetExhausted: true },
    "failed",
    "failed",
    "danger",
    "cloud-x",
    "retry",
  ],
  [
    { state: "online", updateAvailability: "available" },
    "online",
    "online",
    "success",
    "cloud",
    "disconnect",
  ],
  [
    { state: "failed", errorCode: "remote-connection-canceled" },
    "offline",
    "offline",
    "neutral",
    "cloud-off",
    "connect",
  ],
] as const)("投影 %j", (input, status, short, tone, icon, action) => {
  expect(resolveRemoteConnectionPresentation(input)).toMatchObject({
    status,
    shortMessageId: `remote.status.${short}`,
    tone,
    icon,
    primaryAction: action,
  });
});

import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { PUBLIC_ZCODE_ERROR_CODES } from "@zcode/shared";

it.each([
  ["remote-authentication-failed", "authentication", "edit-auth"],
  ["remote-host-unreachable", "hostUnreachable", "retry"],
  ["remote-connection-timeout", "connectionTimeout", "retry"],
  ["remote-host-not-found", "hostNotFound", "edit-host"],
  ["remote-host-key-changed", "hostKeyChanged", "security"],
  ["remote-download-failed", "downloadFailed", "retry"],
  ["remote-upload-failed", "uploadFailed", "retry"],
  ["remote-preflight-failed", "preflightFailed", "retry"],
  ["remote-install-failed", "installFailed", "retry"],
  ["remote-space-insufficient", "spaceInsufficient", "details"],
  ["remote-permission-denied", "permissionDenied", "details"],
  ["remote-connection-canceled", "connectionCanceled", "connect"],
  ["remote-connection-unknown", "unknown", "retry"],
] as const)("错误 %s 给出原因与操作", (errorCode, title, primaryAction) => {
  expect(classifyRemoteConnectionError({ errorCode })).toMatchObject({
    titleId: `remote.error.${title}`,
    primaryAction,
  });
});
it.each(PUBLIC_ZCODE_ERROR_CODES)("公开错误码 %s 有明确映射", (errorCode) => {
  expect(classifyRemoteConnectionError({ errorCode }).category).not.toBe("unrecognized");
});
it.each([undefined, "", "future-error"])("未知错误 %s 安全兜底", (errorCode) => {
  expect(classifyRemoteConnectionError({ errorCode })).toMatchObject({
    titleId: "remote.error.unknown",
    primaryAction: "retry",
  });
});
it.each(["local-download-upload", "remote-download"] as const)(
  "SSH 下载方式 %s 决定切换建议",
  (assetInstallMode) => {
    expect(
      classifyRemoteConnectionError({
        errorCode: "remote-download-failed",
        target: { kind: "ssh", host: "host", username: "dev", assetInstallMode },
      }).allowRemoteDownload,
    ).toBe(assetInstallMode === "local-download-upload");
  },
);
it.each([
  { kind: "wsl", distro: "Ubuntu" },
  { kind: "docker", container: "app" },
] as const)("%j 使用专属文案，不提示远端下载", (target) => {
  expect(
    classifyRemoteConnectionError({ errorCode: "remote-host-not-found", target }),
  ).toMatchObject({
    titleId: `remote.error.hostNotFound.${target.kind}`,
    allowRemoteDownload: false,
  });
});

it("项目级失败保留 owner 已分类的原因，不被设备在线或未知错误模板覆盖", () => {
  const presentation = resolveRemoteConnectionPresentation({
    state: "online",
    attached: false,
    projectError: "远程目录不可用，请检查目录是否存在。",
  });
  expect(presentation.status).toBe("failed");
  expect(presentation.reasonText).toBe("远程目录不可用，请检查目录是否存在。");
});
