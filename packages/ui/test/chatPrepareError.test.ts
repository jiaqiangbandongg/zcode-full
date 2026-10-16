import { describe, expect, it } from "vitest";
import {
  buildCachedWorkspacePrepareUiError,
  buildModelConfigMissingUiError,
  buildWorkspacePrepareUiError,
  getChatErrorMessage,
} from "@/lib/chatPrepareError.js";

describe("chatPrepareError", () => {
  it("provider 等待态投影为 modelConfigMissing 草稿横幅错误", () => {
    expect(buildModelConfigMissingUiError()).toEqual({
      code: "model_config_missing",
      message: "No usable model provider is configured.",
    });
  });

  it("能从结构化对象里提取 message，避免出现 [object Object]", () => {
    const message = getChatErrorMessage({
      code: -32000,
      message: "Authentication required",
    });

    expect(message).toBe("Authentication required");
  });

  it("支持处理 message 为对象的场景", () => {
    const message = getChatErrorMessage({
      message: {
        error: "token expired",
        status: 401,
      },
    });

    expect(message).toBe('{"error":"token expired","status":401}');
  });

  it("workspace 预热错误会补齐 fallback code 与上下文 detail", () => {
    const uiError = buildWorkspacePrepareUiError(
      { code: -32000, message: "Authentication required" },
      {
        workspacePath: "/repo/demo",
        provider: "glm",
        reason: "mount",
        attempt: 2,
        maxAttempts: 5,
      },
    );

    expect(uiError).toMatchObject({
      code: "WORKSPACE_PREPARE_FAILED",
      message: "Authentication required",
      detail: "workspace=/repo/demo provider=glm reason=mount attempt=2/5",
    });
  });

  it("已有 detail 时保持原 detail，不覆盖真实后端细节", () => {
    const uiError = buildWorkspacePrepareUiError(
      {
        message: "Authentication required",
        detail: "server detail",
      },
      {
        workspacePath: "/repo/demo",
        provider: "glm",
        reason: "retry",
        attempt: 3,
        maxAttempts: 5,
      },
    );

    expect(uiError.detail).toBe("server detail");
  });

  it("workspace 预热错误替换展示文案时保留协议 data.code", () => {
    const uiError = buildWorkspacePrepareUiError(
      {
        code: -32603,
        data: {
          code: "model_config_missing",
        },
        message:
          "Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.",
      },
      {
        workspacePath: "/repo/demo",
        provider: "glm",
        reason: "mount",
        attempt: 5,
        maxAttempts: 5,
        displayMessage:
          "Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.",
      },
    );

    expect(uiError).toMatchObject({
      code: "model_config_missing",
      message:
        "Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.",
    });
  });

  it("workspace failed 缓存短路时复用结构化错误 code", () => {
    const message =
      "Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.";
    const cachedError = buildWorkspacePrepareUiError(
      {
        code: -32603,
        data: {
          code: "model_config_missing",
        },
        message,
      },
      {
        workspacePath: "/repo/demo",
        provider: "glm",
        reason: "mount",
        attempt: 5,
        maxAttempts: 5,
        displayMessage: message,
      },
    );

    const uiError = buildCachedWorkspacePrepareUiError(message, cachedError, {
      workspacePath: "/repo/demo",
      provider: "glm",
      reason: "mount",
      attempt: 5,
      maxAttempts: 5,
    });

    expect(uiError).toMatchObject({
      code: "model_config_missing",
      message,
    });
  });
});
