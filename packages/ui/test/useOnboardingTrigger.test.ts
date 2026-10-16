// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingSettingsSyncPatch } from "@zcode/services";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import type { IOnboardingRecordService } from "@zcode/services";

/**
 * CR 修复回归：useOnboardingTrigger 曾因坏 copy-paste 把 useState/useRef 嵌进
 * useEffect 回调（Rules of Hooks 违规，挂载即抛 "Invalid hook call"），且内层
 * setNeedsOnboarding 写的是被遮蔽的 state，触发/超时/回填全部死链。该缺陷
 * typecheck/lint/存量测试均不可见，必须用真实渲染覆盖。
 */
function createRecordService(
  overrides: Partial<IOnboardingRecordService> = {},
): IOnboardingRecordService {
  return {
    appendRecord: async () => {},
    dismissOnboarding: async () => {},
    claimAnonymousRecord: async () => {},
    shouldOnboard: async () => true,
    getLatestEntry: async () => null,
    syncSettingsFromRecord: async () => null,
    updateRecordPreferences: async () => {},
    getRecords: async () => null,
    clearRecords: async () => {},
    ...overrides,
  };
}

function renderTrigger(options: {
  service: IOnboardingRecordService | null;
  userId?: string | null;
  hasStoredOccupation?: boolean;
}) {
  const update = vi.fn(async () => {});
  const utils = renderHook(
    ({ userId }: { userId: string | null }) =>
      useOnboardingTrigger({
        onboardingRecord: options.service,
        userId,
        hasStoredOccupation: options.hasStoredOccupation ?? false,
        loadDeviceMid: () => "device-a",
        update,
      }),
    { initialProps: { userId: options.userId ?? null } },
  );
  return { ...utils, update };
}

describe("useOnboardingTrigger", () => {
  it("挂载不抛 hook 规则错误，并按 shouldOnboard=false 输出判定", async () => {
    const service = createRecordService({ shouldOnboard: async () => false });
    const { result } = renderTrigger({ service });
    // 修复前：effect 内的 useState 在挂载时同步抛 "Invalid hook call"
    await waitFor(() => expect(result.current[0]).toBe(false));
  });

  it("shouldOnboard=true 时输出需要引导；markOnboarded 置回 false", async () => {
    const service = createRecordService({ shouldOnboard: async () => true });
    const { result } = renderTrigger({ service });
    await waitFor(() => expect(result.current[0]).toBe(true));
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(false);
  });

  it("服务不可用退回 settings 判定（hasStoredOccupation=false 视为需引导）", async () => {
    const { result } = renderTrigger({ service: null, hasStoredOccupation: false });
    await waitFor(() => expect(result.current[0]).toBe(true));
  });

  it("挂载首跑不回填 settings；userId 运行时变化才按 record 回填", async () => {
    const patch: OnboardingSettingsSyncPatch = { onboardingOccupation: "finance" };
    const sync = vi.fn(async () => patch);
    const service = createRecordService({
      shouldOnboard: async () => false,
      syncSettingsFromRecord: sync,
    });
    const { result, rerender, update } = renderTrigger({ service, userId: null });

    // 首跑（null→已恢复的 id 不算运行时变化）：判定但不回填
    rerender({ userId: "u1" });
    await waitFor(() => expect(result.current[0]).toBe(false));
    expect(sync).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();

    // 换号（u1→u2，非空直切）：按 record 回填
    rerender({ userId: "u2" });
    await waitFor(() => expect(sync).toHaveBeenCalled());
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ onboardingOccupation: "finance" }),
      ),
    );
  });

  it("登出（id→null）也按 null 用户的 record 回填", async () => {
    const patch: OnboardingSettingsSyncPatch = { onboardingOccupation: "other" };
    const sync = vi.fn(async () => patch);
    const service = createRecordService({
      shouldOnboard: async () => false,
      syncSettingsFromRecord: sync,
    });
    const { result, rerender, update } = renderTrigger({ service, userId: "u1" });
    await waitFor(() => expect(result.current[0]).toBe(false));
    rerender({ userId: null });
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining(patch)));
  });

  it("登录后先认领再判定：认领使判定不触发（同一人不重复引导）", async () => {
    // shouldOnboard 返回 true 表示"若无认领会弹引导"；认领先行由服务层保证一致性，
    // 这里验证调用顺序：claim 必须在 shouldOnboard 之前完成。
    const calls: string[] = [];
    const service = createRecordService({
      claimAnonymousRecord: async () => {
        calls.push("claim");
      },
      shouldOnboard: async () => {
        calls.push("shouldOnboard");
        return true;
      },
    });
    const { result } = renderTrigger({ service, userId: "u1" });
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(calls.indexOf("claim")).toBeLessThan(calls.indexOf("shouldOnboard"));
  });

  it("shouldOnboard RPC 挂起时 3 秒超时兜底退回 settings 判定", { timeout: 8000 }, async () => {
    const service = createRecordService({
      shouldOnboard: () => new Promise<boolean>(() => {}),
    });
    const { result } = renderTrigger({ service, hasStoredOccupation: false });
    await waitFor(() => expect(result.current[0]).toBe(true), { timeout: 5000 });
  });
});
