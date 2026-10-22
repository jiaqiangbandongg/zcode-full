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
 *
 * 兜底语义（2026-10 第二次修订，docs/onboarding-record-spec.md §6）：超时/rejection/
 * 服务不可用一律保守判"不需要引导"，settings 不再参与资格判定——settings 兜底会把
 * "没填过引导的老用户"误判成需要引导（线上 dev 案例：登录瞬间判定早于任务索引回填，
 * shouldOnboard 真实返回 true 误弹；failure 兜底是同一冲突的第二入口）。真新用户在
 * 故障场景最坏晚一次启动再弹。
 *
 * 放行预算跨判定轮次共享：身份变化触发的重跑只使用剩余预算，且已有结果时后续轮次
 * 的超时兜底不生效。
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

type TriggerProps = {
  service: IOnboardingRecordService | null;
  userId?: string | null;
};

function renderTrigger(options: TriggerProps) {
  const update = vi.fn(async () => {});
  // 与真实调用方一致：loadDeviceMid 用稳定引用（useCallback），避免测试里
  // 每次渲染新建函数导致 effect 无意义重跑，干扰重跑次数断言。
  const loadDeviceMid = () => "device-a";
  const utils = renderHook(
    ({ userId }: { userId: string | null }) =>
      useOnboardingTrigger({
        onboardingRecord: options.service,
        userId,
        loadDeviceMid,
        update,
      }),
    {
      initialProps: { userId: options.userId ?? null },
    },
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

  it("服务不可用保守判不引导，不依赖 settings", async () => {
    // 无记录服务的宿主（home-only web 视图、测试 double）恒不自动弹；
    // 旧实现退回 settings 判定会把没填过引导的老用户误弹。
    const { result } = renderTrigger({ service: null });
    await act(async () => {});
    expect(result.current[0]).toBe(false);
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

  it("shouldOnboard RPC 挂起时 3 秒超时保守判为不引导", { timeout: 8000 }, async () => {
    // 超时只代表"结果未知"，必须保守判 false；真实结果到达后照常覆盖（见下一用例）。
    const service = createRecordService({
      shouldOnboard: () => new Promise<boolean>(() => {}),
    });
    const { result } = renderTrigger({ service });
    await waitFor(() => expect(result.current[0]).toBe(false), { timeout: 5000 });
  });

  it(
    "超时保守判定后真实结果到达会覆盖：真新用户的引导只是晚几秒出现",
    { timeout: 8000 },
    async () => {
      let resolveShouldOnboard: ((value: boolean) => void) | undefined;
      const service = createRecordService({
        shouldOnboard: () =>
          new Promise<boolean>((resolve) => {
            resolveShouldOnboard = resolve;
          }),
      });
      const { result } = renderTrigger({ service });
      // 超时先到：保守 false，主界面先行
      await waitFor(() => expect(result.current[0]).toBe(false), { timeout: 5000 });
      // 真实结果（真新用户=true）迟到：覆盖为 true，引导补弹
      await act(async () => {
        resolveShouldOnboard?.(true);
      });
      await waitFor(() => expect(result.current[0]).toBe(true));
    },
  );

  it("shouldOnboard 失败保守判不引导，不退回 settings 判定", async () => {
    // rejection 兜底若读 settings（!onboardingOccupation），没填过引导的老用户
    // 会被误判成需要引导；未知结果必须判 false。
    const service = createRecordService({
      shouldOnboard: () => Promise.reject(new Error("rpc failed")),
    });
    const { result } = renderTrigger({ service });
    await waitFor(() => expect(result.current[0]).toBe(false));
  });

  it(
    "userId 变化重跑不重置放行预算：主界面总等待不超过首个判定轮的 3 秒",
    { timeout: 8000 },
    async () => {
      // 身份变化触发重跑时只使用剩余预算：首轮预算走到 2.9s 后换号重跑，
      // 3.1s（原截止后 0.1s）必须已保守放行，不得重启完整 3 秒。
      vi.useFakeTimers();
      try {
        const service = createRecordService({
          claimAnonymousRecord: () => new Promise<void>(() => {}),
          shouldOnboard: () => new Promise<boolean>(() => {}),
        });
        const { result, rerender } = renderTrigger({ service });
        // 首轮预算走到 2.9s（判定 RPC 挂起，未放行），换号触发重跑
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2900);
        });
        rerender({ userId: "u2" });
        // 旧实现此处重启完整 3 秒；共享预算后只剩 0.1s——3.1s 必须已放行
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(result.current[0]).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    "已有判定结果时后续轮次的超时兜底不再生效，不翻掉进行中的引导",
    { timeout: 8000 },
    async () => {
      // 预算分离的另一半语义：首轮真实结果 true（引导展示中）后身份变化触发重跑，
      // 若重跑的 RPC 挂起，其超时兜底不得把 true 翻成 false 让引导消失。
      vi.useFakeTimers();
      try {
        let calls = 0;
        const service = createRecordService({
          shouldOnboard: () => {
            calls += 1;
            // 首轮立即判 true（真新用户）；第二轮（换号后）挂起
            return calls === 1 ? Promise.resolve(true) : new Promise<boolean>(() => {});
          },
        });
        const { result, rerender } = renderTrigger({ service });
        // fake timers 下不能用 waitFor（轮询定时器被 fake 永不推进）；
        // 首轮立即 resolve，act 刷微任务后直接断言。
        await act(async () => {});
        expect(result.current[0]).toBe(true);
        rerender({ userId: "u2" });
        // 第二轮挂起，即使推过 3 秒也不得翻转首轮的 true
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3500);
        });
        expect(result.current[0]).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("userId 变化会重跑判定（幂等第二轮）", async () => {
    // 换号后按新身份重新判定（A 已答不弹，B 未答 → B 触发引导）。
    let calls = 0;
    const service = createRecordService({
      shouldOnboard: async () => {
        calls += 1;
        return calls > 1;
      },
    });
    const { result, rerender } = renderTrigger({ service, userId: "u1" });
    // 第一轮（u1 已答）返回 false；换号 u2 重跑第二轮返回 true
    await waitFor(() => expect(result.current[0]).toBe(false));
    rerender({ userId: "u2" });
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(calls).toBe(2);
  });
});
