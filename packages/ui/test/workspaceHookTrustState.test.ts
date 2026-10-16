import { describe, expect, it } from "vitest";
import {
  didWorkspaceHookReviewSettle,
  resolveWorkspaceHookReasonCodeMessageId,
  shouldSilenceStaleRejection,
} from "../src/settings/workspaceHookTrustState.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("workspace Hook trust state 展示语义（D19）", () => {
  it("行内 Trust 文案在 zh/en 两侧都存在", () => {
    expect(zhCN["settings.hooks.review.trust"]).toBe("信任");
    expect(enUS["settings.hooks.review.trust"]).toBe("Trust");
  });

  it("只在「有 review → 无 review」跃变时判定审核终结", () => {
    // 授权走行内 Trust、不经 revoke 的 refresh，设置页需据此补刷新，
    // 否则按钮会滞留到组件重挂载（2026-08-11 UAT）。
    expect(
      didWorkspaceHookReviewSettle({
        previousInteractionId: "interaction-1",
        currentInteractionId: undefined,
      }),
    ).toBe(true);

    // 初次挂载：从来没有过 review，不得触发——否则会紧随 initialize 多加载一次。
    expect(
      didWorkspaceHookReviewSettle({
        previousInteractionId: undefined,
        currentInteractionId: undefined,
      }),
    ).toBe(false);

    // 审核刚打开、以及 supersede 换代（仍有 review）都不算终结。
    expect(
      didWorkspaceHookReviewSettle({
        previousInteractionId: undefined,
        currentInteractionId: "interaction-1",
      }),
    ).toBe(false);
    expect(
      didWorkspaceHookReviewSettle({
        previousInteractionId: "interaction-1",
        currentInteractionId: "interaction-2",
      }),
    ).toBe(false);
  });

  it("reasonCode 映射到非空 i18n key，未知码回退到通用拒绝文案而非原始码", () => {
    // Bug（2026-08-11 UAT）：命令被拒绝时直接把原始 reasonCode 渲染给用户，
    // 中英文用户都不可读。映射后未知码必须回退到通用文案，不暴露内部枚举字面量。
    const knownCodes = [
      "workspace_hooks_review_superseded",
      "workspace_hooks_snapshot_mismatch",
      "workspace_hooks_bundle_changed",
      "workspace_hooks_config_unreadable",
      "workspace_hooks_config_write_failed",
      "workspace_hooks_config_rebuild_failed",
      "workspace_hooks_trust_store_corrupt",
      "workspace_hooks_blocked_by_policy",
      "workspace_hooks_policy_requires_pretrust",
      "workspace_hooks_interaction_timeout",
      "workspace_hooks_require_trust_capable_host",
    ];

    for (const code of knownCodes) {
      const id = resolveWorkspaceHookReasonCodeMessageId(code);
      expect(id, `${code} 应映射到非空 key`).toBeTruthy();
      expect(id, `${code} 不得回退为原始码`).not.toBe(code);
      // 每个 key 在 zh/en 两侧都必须存在，缺 key 会把原始 id 渲染到界面。
      expect(zhCN[id], `zh-CN 缺 ${id}`).toBeTruthy();
      expect(enUS[id], `en-US 缺 ${id}`).toBeTruthy();
    }

    // 未知码回退到通用拒绝文案。
    const fallback = resolveWorkspaceHookReasonCodeMessageId("totally_unknown_code");
    expect(fallback).toBe("settings.hooks.review.reason.rejected");
    expect(fallback).not.toBe("totally_unknown_code");
    expect(zhCN[fallback]).toBeTruthy();
    expect(enUS[fallback]).toBeTruthy();

    // undefined / 空值同样回退。
    expect(resolveWorkspaceHookReasonCodeMessageId(undefined)).toBe(
      "settings.hooks.review.reason.rejected",
    );
  });
});

describe("双击 stale superseded 静默收敛（#9）", () => {
  it("superseded + 本地已无 live pending binding（双击第二次）⇒ 静默", () => {
    // Bugfix（#9）：双击 Trust 按钮时第一次点击成功并终结审核（store clear binding），
    // 第二次点击的 commandId 被验证为已终结的 flow，返回 superseded。此刻本地已无
    // pending binding，说明用户意图已达成——不应展示错误。
    expect(
      shouldSilenceStaleRejection({
        reasonCode: "workspace_hooks_review_superseded",
        hasLivePendingBinding: false,
      }),
    ).toBe(true);
  });

  it("superseded + 本地仍有 live pending binding（bundle 变更等真正 supersede）⇒ 展示", () => {
    // 真正的 superseded：审核期间 bundle 变更，Runtime 推翻了当前 flow，但新的 review
    // binding 已建立（仍 pending）。用户必须重新审核——此错误必须展示。
    expect(
      shouldSilenceStaleRejection({
        reasonCode: "workspace_hooks_review_superseded",
        hasLivePendingBinding: true,
      }),
    ).toBe(false);
  });

  it("非 superseded 的 rejection 一律展示，不论 binding 状态", () => {
    // snapshot_mismatch、blocked_by_policy 等 rejection 与双击无关，必须始终展示。
    for (const reasonCode of [
      "workspace_hooks_snapshot_mismatch",
      "workspace_hooks_blocked_by_policy",
      "workspace_hooks_bundle_changed",
      undefined,
    ]) {
      expect(
        shouldSilenceStaleRejection({
          reasonCode,
          hasLivePendingBinding: false,
        }),
      ).toBe(false);
      expect(
        shouldSilenceStaleRejection({
          reasonCode,
          hasLivePendingBinding: true,
        }),
      ).toBe(false);
    }
  });
});
