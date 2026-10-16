// 独立 CLI 的动态工作流 mode（docs/dynamic-workflow/launch.md「The standalone CLI: `--workflow-mode`」）。
// TUI 与 headless 没有 Host 下发灰度 mode，由进程参数决定；缺省 disabled，即工作流在独立 CLI 里需显式开启。
// mode 只在这里折成 core 的两个显式字段，bootstrap / core 沿用协议服务端的同一套后果。
import {
  DYNAMIC_WORKFLOW_MODES,
  normalizeDynamicWorkflowMode,
  type DynamicWorkflowMode,
} from "@zcode/shared";

export const DEFAULT_CLI_WORKFLOW_MODE: DynamicWorkflowMode = "disabled";

export const WORKFLOW_MODE_SCOPE_ERROR =
  "--workflow-mode can only be used with --prompt, --target, or tui.";

export const WORKFLOW_DISABLED_NOTICE =
  "Dynamic workflows are disabled in this session. Restart with --workflow-mode onDemand or --workflow-mode alwaysOn to use them.";

export type CliWorkflowRuntimeConfig = {
  dynamicWorkflowEnabled: boolean;
  dynamicWorkflowToolsOnDemand: boolean;
};

/** 非法值抛错，由入口层格式化；缺省值不在这里补，入口层据此区分「未传」做作用域检查。 */
export function normalizeWorkflowModeOption(
  value: string | undefined,
): DynamicWorkflowMode | undefined {
  if (value === undefined) return undefined;
  const mode = normalizeDynamicWorkflowMode(value);
  if (mode !== undefined) return mode;
  throw new Error(
    `Unsupported --workflow-mode value: ${value}. Supported modes: ${DYNAMIC_WORKFLOW_MODES.join(", ")}.`,
  );
}

/**
 * 两个字段都显式写出：core 把缺席当作开启（子代理、进程内嵌入方靠这个极性），
 * 独立 CLI 若留空就会绕过缺省 disabled。
 */
export function resolveWorkflowModeRuntimeConfig(
  mode: DynamicWorkflowMode,
): CliWorkflowRuntimeConfig {
  return {
    dynamicWorkflowEnabled: mode !== "disabled",
    dynamicWorkflowToolsOnDemand: mode === "onDemand",
  };
}

export function isWorkflowModeEnabled(mode: DynamicWorkflowMode | undefined): boolean {
  // 缺席 = 调用方没接入 mode（单测、嵌入方），不在命令面设门；CLI 入口总会传入解析后的值。
  return mode !== "disabled";
}
