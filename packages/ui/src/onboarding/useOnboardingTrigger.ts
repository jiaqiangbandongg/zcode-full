import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * 引导触发判定：当前用户在本地记录里没有条目时 needsOnboarding=true（null 表示异步
 * 判定中）。
 *
 * 兜底语义（docs/onboarding-record-spec.md §6，2026-10 第二次修订）：超时、rejection、
 * record 服务不可用一律保守判 false——失败只代表"结果未知"，不得据此打扰用户。旧实现
 * 退回 settings 判定（!onboardingOccupation），会把没填过引导的老用户误判成需要引导
 * （线上 dev 案例：登录瞬间判定早于任务索引回填，shouldOnboard 返回 true 误弹老用户；
 * settings 兜底是同一冲突的第二入口）。真新用户在故障场景最坏晚一次启动再弹；真实结果
 * 到达后照常覆盖。3 秒放行预算与判定轮次分离：截止时刻在首个未决判定轮建立并跨轮共享
 * （身份变化触发重跑只使用剩余预算），产生判定结果后预算结束，已有结果时后续轮次的
 * 超时兜底不再生效。
 *
 * 返回 [needsOnboarding, markOnboarded]：markOnboarded 在引导保存成功后把判定置 false
 * （记录已落盘，本次会话不再触发）。
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, loadDeviceMid, update } = options;
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // 记录上一次判定时的 userId，回填只在身份实际变化后发生（见下方回填条件）。
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  // 状态镜像：超时回调读"是否已产生判定结果"，避免闭包捕获陈旧 state。
  const needsOnboardingRef = useRef<boolean | null>(null);
  needsOnboardingRef.current = needsOnboarding;
  // 放行预算（截止时刻）与判定轮次分离：userId/服务实例变化触发重跑时只使用剩余预算，
  // 不重新授予主界面阻塞时间；产生判定结果后预算结束，已有结果时后续轮次的超时兜底
  // 不再生效——不得把已放行的主界面或进行中的引导翻掉。
  const releaseDeadlineRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    // 服务不可用（旧测试 double / 未注册的 host）保守判不引导：老用户一定不弹，
    // 真新用户等装配修复后下次启动补弹或走设置页手动入口。
    if (!onboardingRecord) {
      setNeedsOnboarding(false);
      return;
    }
    // shouldOnboard 走 RPC，host 未带上 onboarding-record channel 时调用会挂起，
    // 判定期间渲染 null 会把疑似首跑用户的主界面拦成黑屏，因此保留 3 秒兜底放行。
    // 超时保守判"不引导"：超时只代表"结果未知"，不得据此打扰用户（真新用户的引导随
    // 真实结果到达补弹，主界面先行几秒，属可接受代价）。
    if (needsOnboardingRef.current === null) {
      releaseDeadlineRef.current ??= Date.now() + 3000;
    }
    const deadline = releaseDeadlineRef.current;
    const timeout =
      deadline === null
        ? null
        : setTimeout(
            () => {
              if (cancelled || needsOnboardingRef.current !== null) return;
              releaseDeadlineRef.current = null;
              logger.warn("[occupation-onboarding] shouldOnboard 超时，保守判定为不引导");
              setNeedsOnboarding(false);
            },
            Math.max(0, deadline - Date.now()),
          );
    // 登录认领先行：未登录时答的引导（null 条目）移交给当前登录用户，同一人不重复引导。
    // 必须 await 完成后再判定，否则 shouldOnboard 读到认领前的文件会误判需要引导。
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 认领匿名引导记录失败", { error: String(cause) });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) {
            releaseDeadlineRef.current = null;
            setNeedsOnboarding(result);
          }
          // 换账号恢复该用户偏好：settings 不分用户，A 答完后 B 触发引导会把 settings 顶成
          // B 的答案；再切回 A 时按 record 最近作答回填。同步失败只留日志。
          // 仅"上次是非空的另一身份"时回填（A→B 直切、B→登出）。null→id 不回填：启动 OAuth
          // 恢复与运行中登录共用该序列且无法区分，宁可少回填——手动修改已由各入口回写
          // record（record=最新偏好），缺失回填只影响"apikey 态后登录旧账号"这类边缘场景。
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void onboardingRecord
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] 按记录同步偏好失败", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          // 判定失败只代表"结果未知"，保守判不引导：旧实现退回 settings 判定
          // （!onboardingOccupation），没填过引导的老用户会被误弹——与"老用户一定
          // 不弹"冲突，且失败时 settings 快照可信度同样存疑。
          logger.warn("[occupation-onboarding] shouldOnboard 检查失败，保守判定为不引导", {
            error: String(cause),
          });
          if (!cancelled) {
            releaseDeadlineRef.current = null;
            setNeedsOnboarding(false);
          }
        },
      )
      .finally(() => {
        if (timeout !== null) clearTimeout(timeout);
      });
    return () => {
      cancelled = true;
      if (timeout !== null) clearTimeout(timeout);
    };
    // 重跑条件=判定上下文（服务实例 / 身份 / 设备 id）；重跑只刷新判定上下文，不重置
    // 放行预算（见 releaseDeadlineRef）。不依赖 settings：settings 不再参与资格判定
    // （spec §6），仅由调用方用于"存量用户不等判定直接进主界面"的 UI 放行。
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [
    needsOnboarding,
    () => {
      // 用户完成引导保存成功即产生判定结果，结束放行预算，防止残留轮次的兜底翻转。
      releaseDeadlineRef.current = null;
      setNeedsOnboarding(false);
    },
  ];
}
