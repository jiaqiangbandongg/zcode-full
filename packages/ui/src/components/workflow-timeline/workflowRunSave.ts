// 完成卡「保存 / 再次运行」的纯逻辑（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）：名字规则、落点预览、交给 ZCode 的那条消息。
//
// 与组件分文件的理由同 globalWorkflowGroupHelpers：这些判定没有 React，也该能被单独测。
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";

/**
 * 名字的合法形状，与 agent 侧 `isValidSavedWorkflowName`（@zcode/contracts）**逐字相同**。
 * 这里再写一遍不是重复实现而是**前置回声**：用户每敲一个字符都要知道这个名字能不能当文件名，
 * 而那条规则本身（字符集 + 长度 + 不是 `.` / `..`）是路径穿越的防线，两侧都不能松。
 * 真正的裁决仍在 agent：这里只负责在点下去之前就把话说清楚。
 */
const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
export const SAVED_WORKFLOW_NAME_MAX_CHARS = 64;

export function isValidSavedWorkflowNameText(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_NAME_MAX_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  return name.replaceAll(".", "").length > 0;
}

/**
 * 落点预览。项目档写相对路径（用户在自己的仓库里看到的就是它），全局档写 `~` 开头的家目录路径
 * ——那是 **agent 机器**的家目录，远程项目因此根本不给全局档这个选项。
 */
export function savedWorkflowPathPreview(scope: ZCodeSavedWorkflowScope, name: string): string {
  const file = `${name}.dwf.ts`;
  return scope === "global" ? `~/.zcode/workflows/${file}` : `.zcode/workflows/${file}`;
}

export interface WorkflowSaveDraft {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}

/**
 * 弹层打开那一刻的草稿。
 *
 * 名字只在 run 名**本身**就满足文件名规则时预填：run 名是模型用用户的语言起的标签
 * （「PR 分层评审 · 安全 / 性能 / 架构」），把它塞进名字框只会得到一个必然报错的值。
 * 说明则反过来预填 run 名——它正是「这个工作流是做什么的」的一句话，而中枢的卡片上要的就是这句。
 */
export function initialWorkflowSaveDraft(input: {
  runName?: string;
  scope?: ZCodeSavedWorkflowScope;
}): WorkflowSaveDraft {
  const runName = input.runName?.trim() ?? "";
  return {
    name: isValidSavedWorkflowNameText(runName) ? runName : "",
    scope: input.scope ?? "project",
    description: runName,
  };
}

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

/**
 * 「让 ZCode 帮我提炼保存」发出去的那条用户消息（docs/dynamic-workflow/transcript-and-notifications.md
 * 「The message the lead sends」）。与中枢的「提升为全局」同一条先例：GUI 写、自动发、用户不再确认。
 *
 * 三件事必须在消息里：**提炼**而不是照抄（否则这条路径与「直接保存」没有分别）、用户已经填好的
 * 那几个字段、以及 `run_id`——它是这次 run 与模型另起名字存下的那份定义之间**仅有的**持久联系
 * （launch.md「`SaveWorkflow`」）。脚本不进消息：模型手上就有发起这次 run 的调用。
 */
export function buildWorkflowSaveRequestPrompt(input: {
  locale: string;
  runId: string;
  runName?: string;
  name: string;
  scope: ZCodeSavedWorkflowScope;
  description: string;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  const runName = input.runName?.trim();
  if (isZh(input.locale)) {
    const target =
      input.scope === "global" ? '保存为全局工作流（scope: "global"）' : "保存到本项目";
    return [
      `请把刚跑完的工作流${runName ? `「${runName}」` : ""}提炼成可以复用的工作流，用 SaveWorkflow ${target}：`,
      "1. 脚本以这次运行实际执行的那一份为准，不要改动它的逻辑。",
      "2. 把两次运行之间会变化的值抽成 args（写好说明与合理默认值），并补齐 description 与 whenToUse。",
      name.length > 0 ? `3. 名字用 \`${name}\`。` : "3. 名字请你来取（只能用字母、数字和 - _ .）。",
      description.length > 0 ? `4. 说明可以参考：${description}` : "",
      `5. 调用 SaveWorkflow 时带上 run_id: "${input.runId}"——这次运行要据此认出自己已被保存。`,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  const target =
    input.scope === "global"
      ? 'save it as a global workflow (scope: "global")'
      : "save it to this project";
  return [
    `Please distill the workflow that just finished${runName ? ` ("${runName}")` : ""} into a reusable one and ${target} with SaveWorkflow:`,
    "1. Use the script this run actually executed; do not change its logic.",
    "2. Lift the values that change between runs into args (with descriptions and sensible defaults), and write description and whenToUse.",
    name.length > 0
      ? `3. Name it \`${name}\`.`
      : "3. Pick the name yourself (letters, digits and - _ . only).",
    description.length > 0 ? `4. For the description, start from: ${description}` : "",
    `5. Pass run_id: "${input.runId}" to SaveWorkflow, so that run can tell it has been saved.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
