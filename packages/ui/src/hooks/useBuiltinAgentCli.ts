/* eslint-disable max-lines -- 内置 Agent CLI 的安装/卸载状态、随机进度模板与设置同步目前集中在同一 hook，先保持收口，避免把同一条交互链拆散。 */
import { useCallback, useMemo, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveBuiltinAgentCliStatus,
  getEffectiveBuiltinAgentCliProvider,
  getEnabledBuiltinAgentCliProviders,
  requiresBuiltinAgentCliInstall,
  type BuiltinAgentCliStatus,
} from "@/lib/builtinAgentCli.js";
import {
  persistLastSelectedAgentProvider,
  readLastSelectedAgentProvider,
} from "@/lib/zcodeProviderPreference.js";

const MIN_INSTALL_DURATION_MS = 5_000;
const MAX_INSTALL_DURATION_MS = 10_000;
const MIN_UNINSTALL_DURATION_MS = 3_000;
const MAX_UNINSTALL_DURATION_MS = 5_000;
const INSTALL_PROGRESS_TICK_MS = 16;

type InstallStageKey = "warmup" | "accelerate" | "settle" | "finish";

type InstallStagePlan = {
  key: InstallStageKey;
  startProgress: number;
  endProgress: number;
  startAtMs: number;
  endAtMs: number;
  easing: (t: number) => number;
};

type InstallPausePlan = {
  triggerProgress: number;
  durationMs: number;
  consumed: boolean;
};

type InstallProgressPlan = {
  totalDurationMs: number;
  stages: InstallStagePlan[];
  pauses: InstallPausePlan[];
};

type InstallTemplateKey = "balanced" | "fastMiddle" | "heavyTail";

type InstallTemplate = {
  key: InstallTemplateKey;
  stage1EndRange: [number, number];
  stage2EndRange: [number, number];
  stage3EndRange: [number, number];
  stageDurationRatioRanges: [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  stage2To3PauseDurationRange: [number, number];
  stage3To4PauseDurationRange: [number, number];
};

const INSTALL_TEMPLATES: InstallTemplate[] = [
  {
    key: "balanced",
    stage1EndRange: [5, 8],
    stage2EndRange: [60, 72],
    stage3EndRange: [92, 97],
    stageDurationRatioRanges: [
      [14, 18],
      [34, 40],
      [28, 34],
      [12, 18],
    ],
    stage2To3PauseDurationRange: [250, 700],
    stage3To4PauseDurationRange: [900, 2200],
  },
  {
    key: "fastMiddle",
    stage1EndRange: [4, 7],
    stage2EndRange: [70, 78],
    stage3EndRange: [91, 96],
    stageDurationRatioRanges: [
      [12, 16],
      [30, 36],
      [30, 36],
      [14, 20],
    ],
    stage2To3PauseDurationRange: [220, 620],
    stage3To4PauseDurationRange: [1000, 2400],
  },
  {
    key: "heavyTail",
    stage1EndRange: [6, 8],
    stage2EndRange: [58, 66],
    stage3EndRange: [94, 99],
    stageDurationRatioRanges: [
      [15, 19],
      [32, 37],
      [29, 35],
      [15, 21],
    ],
    stage2To3PauseDurationRange: [280, 780],
    stage3To4PauseDurationRange: [1200, 2600],
  },
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t ** 3
    : 1 - ((-2 * t + 2) ** 3) / 2;
}

function easeInCubic(t: number): number {
  return t ** 3;
}

function linear(t: number): number {
  return t;
}

function pickInstallTemplate(): InstallTemplate {
  const templateIndex = randomInt(0, INSTALL_TEMPLATES.length - 1);
  return INSTALL_TEMPLATES[templateIndex] ?? INSTALL_TEMPLATES[0]!;
}

function pickInstallStageDurations(
  totalDurationMs: number,
  template: InstallTemplate,
): [number, number, number, number] {
  const stage1Ratio =
    randomInt(template.stageDurationRatioRanges[0][0], template.stageDurationRatioRanges[0][1]) /
    100;
  const stage2Ratio =
    randomInt(template.stageDurationRatioRanges[1][0], template.stageDurationRatioRanges[1][1]) /
    100;
  const stage3Ratio =
    randomInt(template.stageDurationRatioRanges[2][0], template.stageDurationRatioRanges[2][1]) /
    100;
  const minStage4Ratio = template.stageDurationRatioRanges[3][0] / 100;
  const normalizedStage4Ratio = Math.max(minStage4Ratio, 1 - stage1Ratio - stage2Ratio - stage3Ratio);
  const ratioSum = stage1Ratio + stage2Ratio + stage3Ratio + normalizedStage4Ratio;
  const normalizedRatios: [number, number, number, number] = [
    stage1Ratio / ratioSum,
    stage2Ratio / ratioSum,
    stage3Ratio / ratioSum,
    normalizedStage4Ratio / ratioSum,
  ];
  const rawDurations: [number, number, number, number] = [
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[0])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[1])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[2])),
    Math.max(1, Math.floor(totalDurationMs * normalizedRatios[3])),
  ];
  const assignedDuration = rawDurations.reduce((sum, duration) => sum + duration, 0);
  rawDurations[3] += totalDurationMs - assignedDuration;
  return rawDurations;
}

function createInstallProgressPlan(): InstallProgressPlan {
  const template = pickInstallTemplate();
  const totalDurationMs = randomInt(
    MIN_INSTALL_DURATION_MS,
    MAX_INSTALL_DURATION_MS,
  );
  const stage1End = randomInt(template.stage1EndRange[0], template.stage1EndRange[1]);
  const stage2End = randomInt(template.stage2EndRange[0], template.stage2EndRange[1]);
  const stage3End = randomInt(template.stage3EndRange[0], template.stage3EndRange[1]);
  const [stage1Duration, stage2Duration, stage3Duration] =
    pickInstallStageDurations(totalDurationMs, template);

  const stages: InstallStagePlan[] = [
    {
      key: "warmup",
      startProgress: 0,
      endProgress: stage1End,
      startAtMs: 0,
      endAtMs: stage1Duration,
      easing: easeOutCubic,
    },
    {
      key: "accelerate",
      startProgress: stage1End,
      endProgress: stage2End,
      startAtMs: stage1Duration,
      endAtMs: stage1Duration + stage2Duration,
      easing: easeInOutCubic,
    },
    {
      key: "settle",
      startProgress: stage2End,
      endProgress: stage3End,
      startAtMs: stage1Duration + stage2Duration,
      endAtMs: stage1Duration + stage2Duration + stage3Duration,
      easing: easeInCubic,
    },
    {
      key: "finish",
      startProgress: stage3End,
      endProgress: 100,
      startAtMs: stage1Duration + stage2Duration + stage3Duration,
      endAtMs: totalDurationMs,
      easing: linear,
    },
  ];

  const stage2To3PauseCount = randomInt(1, 2);
  const phase2To3PauseStart = Math.min(stage2End + 2, stage3End - 4);
  const phase2To3PauseEnd = Math.max(phase2To3PauseStart, stage3End - 6);
  const pauses: InstallPausePlan[] = [];

  for (let index = 0; index < stage2To3PauseCount; index += 1) {
    const segmentStart =
      phase2To3PauseStart +
      Math.floor(((phase2To3PauseEnd - phase2To3PauseStart) * index) / stage2To3PauseCount);
    const segmentEnd =
      phase2To3PauseStart +
      Math.floor(
        ((phase2To3PauseEnd - phase2To3PauseStart) * (index + 1)) /
          stage2To3PauseCount,
      );

    pauses.push({
      triggerProgress: clamp(
        randomInt(segmentStart, Math.max(segmentStart, segmentEnd)),
        stage2End + 1,
        Math.max(stage2End + 1, stage3End - 3),
      ),
      durationMs: randomInt(
        template.stage2To3PauseDurationRange[0],
        template.stage2To3PauseDurationRange[1],
      ),
      consumed: false,
    });
  }

  pauses.push({
    // Bugfix: 之前尾段的停顿靠概率触发，偶发会完全错过“快完成但还要收尾”的重停感。
    // 这里改成在阶段 3 -> 4 交界前预排一个必定触发的重停点，让尾段节奏稳定可复现。
    triggerProgress: clamp(stage3End - randomInt(1, 2), stage2End + 1, 99),
    durationMs: randomInt(
      template.stage3To4PauseDurationRange[0],
      template.stage3To4PauseDurationRange[1],
    ),
    consumed: false,
  });

  return {
    totalDurationMs,
    stages,
    pauses,
  };
}

function getInstallTargetProgressAtElapsed(
  plan: InstallProgressPlan,
  elapsedMs: number,
): number {
  const clampedElapsed = clamp(elapsedMs, 0, plan.totalDurationMs);
  const lastStage = plan.stages[plan.stages.length - 1];
  if (!lastStage) {
    return 100;
  }
  const activeStage =
    plan.stages.find((stage) => clampedElapsed <= stage.endAtMs) ??
    lastStage;
  const stageDuration = Math.max(1, activeStage.endAtMs - activeStage.startAtMs);
  const stageElapsed = clamp(
    clampedElapsed - activeStage.startAtMs,
    0,
    stageDuration,
  );
  const easedProgress = activeStage.easing(stageElapsed / stageDuration);
  return Math.floor(
    activeStage.startProgress +
      (activeStage.endProgress - activeStage.startProgress) * easedProgress,
  );
}

async function simulateInstallProgress(
  provider: ZCodeProvider,
  setProgress: (provider: ZCodeProvider, progress: number | null) => void,
): Promise<void> {
  const plan = createInstallProgressPlan();
  const startedAt = Date.now();
  let progress = 0;

  setProgress(provider, progress);

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= plan.totalDurationMs) {
      break;
    }

    const nextProgressTarget = getInstallTargetProgressAtElapsed(plan, elapsed);
    if (progress < nextProgressTarget) {
      // Bugfix: 之前的百分比推进混杂了“目标曲线”和“随机停顿”两类职责，
      // 越调越难预测。这里拆成“计划目标 + 1% 追赶”模型，既能保证 0-100 不跳号，
      // 又能让四阶段节奏只由阶段曲线本身决定。
      progress += 1;
      setProgress(provider, progress);

      const pendingPause = plan.pauses.find(
        (pause) => !pause.consumed && progress >= pause.triggerProgress,
      );
      if (pendingPause) {
        pendingPause.consumed = true;
        await sleep(
          Math.min(
            pendingPause.durationMs,
            Math.max(0, plan.totalDurationMs - (Date.now() - startedAt)),
          ),
        );
      }

      continue;
    }

    const remaining = plan.totalDurationMs - elapsed;
    await sleep(Math.min(remaining, INSTALL_PROGRESS_TICK_MS));
  }

  while (progress < 100) {
    progress += 1;
    setProgress(provider, progress);
    await sleep(randomInt(30, 90));
  }
}

async function simulateUninstallDelay(): Promise<void> {
  await sleep(randomInt(MIN_UNINSTALL_DURATION_MS, MAX_UNINSTALL_DURATION_MS));
}

export function useBuiltinAgentCli() {
  const { settings, loading, refresh, update } = useSettings();
  const [enablingProvider, setEnablingProvider] = useState<ZCodeProvider | null>(null);
  const [disablingProvider, setDisablingProvider] = useState<ZCodeProvider | null>(null);
  const [installProgressByProvider, setInstallProgressByProvider] = useState<
    Partial<Record<ZCodeProvider, number>>
  >({});
  const [error, setError] = useState<string | null>(null);

  const enabledProviders = useMemo(
    () => getEnabledBuiltinAgentCliProviders(settings),
    [settings],
  );
  const activeMutatingProvider = enablingProvider ?? disablingProvider;
  const hasPendingMutation = activeMutatingProvider !== null;

  const isEnabled = useCallback(
    (provider: ZCodeProvider) => enabledProviders.includes(provider),
    [enabledProviders],
  );

  const getEffectiveProvider = useCallback(
    (provider: ZCodeProvider) => getEffectiveBuiltinAgentCliProvider(settings, provider),
    [settings],
  );

  const getStatus = useCallback(
    (provider: ZCodeProvider): BuiltinAgentCliStatus =>
      resolveBuiltinAgentCliStatus({
        provider,
        enabledProviders,
        enablingProvider,
        disablingProvider,
      }),
    [disablingProvider, enabledProviders, enablingProvider],
  );

  const canMutateProvider = useCallback(
    (provider: ZCodeProvider) =>
      !hasPendingMutation || activeMutatingProvider === provider,
    [activeMutatingProvider, hasPendingMutation],
  );

  const installProvider = useCallback(
    async (provider: ZCodeProvider) => {
      if (!canMutateProvider(provider)) {
        return;
      }

      if (!requiresBuiltinAgentCliInstall(provider) || isEnabled(provider)) {
        return;
      }

      setEnablingProvider(provider);
      setError(null);

      try {
        await simulateInstallProgress(provider, (targetProvider, progress) => {
          setInstallProgressByProvider((current) => {
            if (progress === null) {
              const { [targetProvider]: _ignoredProvider, ...restProgress } = current;
              return restProgress;
            }

            return {
              ...current,
              [targetProvider]: progress,
            };
          });
        });

        const nextEnabledProviders = [...enabledProviders, provider];
        await update({
          enabledBuiltinAgentCliProviders: nextEnabledProviders,
        });
      } catch (installError) {
        setError(
          installError instanceof Error
            ? installError.message
            : String(installError),
        );
        throw installError;
      } finally {
        setEnablingProvider((current) => (current === provider ? null : current));
        setInstallProgressByProvider((current) => {
          const { [provider]: _ignoredProvider, ...restProgress } = current;
          return restProgress;
        });
      }
    },
    [canMutateProvider, enabledProviders, isEnabled, update],
  );

  const uninstallProvider = useCallback(
    async (provider: ZCodeProvider) => {
      if (!canMutateProvider(provider)) {
        return;
      }

      if (!requiresBuiltinAgentCliInstall(provider) || !isEnabled(provider)) {
        return;
      }

      setDisablingProvider(provider);
      setError(null);

      try {
        await simulateUninstallDelay();

        const nextEnabledProviders = enabledProviders.filter(
          (candidate) => candidate !== provider,
        );
        await update({
          enabledBuiltinAgentCliProviders: nextEnabledProviders,
        });

        // Bugfix: 卸载内置 CLI 后如果仍保留 localStorage 里的“最近一次选中的 provider”，
        // 新建 workspace / 新建草稿时默认 provider 还是会回到这个已卸载的值，
        // 菜单触发器看起来就像“它依然可用”。这里同步把持久化偏好回退到始终可用的 glm。
        if (readLastSelectedAgentProvider() === provider) {
          persistLastSelectedAgentProvider("glm");
        }
      } catch (uninstallError) {
        setError(
          uninstallError instanceof Error
            ? uninstallError.message
            : String(uninstallError),
        );
        throw uninstallError;
      } finally {
        setDisablingProvider((current) => (current === provider ? null : current));
      }
    },
    [canMutateProvider, enabledProviders, isEnabled, update],
  );

  return {
    settings,
    loading,
    refreshing: loading,
    error,
    enabledProviders,
    isEnabled,
    hasPendingMutation,
    activeMutatingProvider,
    canMutateProvider,
    getEffectiveProvider,
    getStatus,
    getInstallProgress: (provider: ZCodeProvider) =>
      installProgressByProvider[provider] ?? null,
    installProvider,
    uninstallProvider,
    refresh,
  };
}
