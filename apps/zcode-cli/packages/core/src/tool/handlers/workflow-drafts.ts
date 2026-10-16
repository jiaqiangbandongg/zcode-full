// ============================================================
// Workflow 草稿目录的写入
// ============================================================
// 每一段被工具收下的脚本都要在盘上有个家，那个文件就是模型两次提交之间的**把手**：诊断给
// 的是文件行号，下一次提交只要 `path`，改一行不必把两万 token 的脚本再流一遍。内联文本因此
// 只是一道门——`CreateWorkflow` / `AmendWorkflow` / 中枢直接启动一收到不来自文件的脚本，就在
// 这里写一个。
//
// 落点 `<cwd>/.zcode/workflow-drafts/`，与 `.zcode/workflows/`（用户保存的定义）、
// `.zcode/workflow-runs/`（每个 run 的编译入口）平级。目录自带一份 `.gitignore: *`，写法与
// dynamic-workflow-runtime/src/child-entry-file.ts 逐字同构（那里的注释记着裁决）：只在缺席时
// 写一次，用户改过就不再动它，项目自己的 `.gitignore` 一个字都不碰。
//
// **尽力而为**：写不进去（只读 checkout、`.zcode` 是个普通文件、盘满）不让调用失败，返回
// `undefined`，模型读到的退回「改好脚本再内联提交」的老话。刻意**不**回落到临时目录——一个
// 用户在项目里找不到的草稿不值得一条路径。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  WORKFLOW_DRAFTS_DIR,
  createWorkflowPhaseNames,
  type CreateWorkflowCausalityGraph,
} from "@zcode/contracts";

/**
 * 草稿文件名**不**保留的字符：任何 Unicode 字母 / 数字与 `_ . -` 之外的一切。
 *
 * 与保存定义的名字（纯 ASCII）刻意不同：保存名要当 CLI 参数与 URL 片段用，草稿名只要能在
 * 三个平台的文件系统上存在、且让人和模型认得出这是哪个工作流——而实盘里 run 名与阶段名
 * 几乎都是中文（实测：ASCII 版把每一份草稿都压成了 `workflow-N`，两个完全不同的
 * 工作流在目录里无法分辨）。字母表之外被丢掉的正是路径分隔符与 Windows 的保留字符
 * （`/ \ : * ? " < > |`）、空白与控制字符，路径穿越因此仍不可能。
 */
const WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu;

/** 空白连成一个 `-`：`PR review #12` → `PR-review-12`，比挤成一团的 `PRreview12` 认得出。 */
const WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu;

/** 文件名长度上限，与 `SAVED_WORKFLOW_MAX_NAME_CHARS` 同一个数，理由也同一条（各平台的 PATH_MAX）。 */
const WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64;

/**
 * 名字里一个可用字符都不剩时的兜底（中文名是最常见的那一种）。
 */
export const WORKFLOW_DRAFT_FALLBACK_SLUG = "workflow";

/**
 * 同名时的后缀上界。撞满这么多次只可能是有人在拿同一个名字刷提交，此时放弃写草稿（返回
 * `undefined`）比无限循环体面——草稿是便利，不是正确性的一环。
 */
const WORKFLOW_DRAFT_MAX_ATTEMPTS = 1_000;

export interface WriteWorkflowDraftInput {
  /**
   * 会话工作目录；草稿落在它的 `.zcode/workflow-drafts/` 下。缺席即宿主没有工作目录概念
   * （端口 stub / 无会话上下文），此时无处可写，与写失败同义。
   */
  cwd: string | undefined;
  /** run 的展示名，用来铸文件名。 */
  name: string;
  /** 要写下的字节，逐字不改（saved 来源连元数据块一起）。 */
  source: string;
}

/**
 * 写一份草稿，返回它的绝对路径；写不成返回 `undefined`（绝不抛）。
 *
 * **每次内联提交都铸一个新文件**，包括一次本该走 `path` 的提交：草稿绝不在模型背后被覆盖，
 * 否则一次手误的重复提交会把用户正在编辑的那一份抹掉。同名冲突按 `-2`、`-3`… 顺延，且用
 * `wx`（独占创建）落盘——两次并发提交因此不可能落进同一个文件，"先 stat 再写"那种写法会。
 */
export async function writeWorkflowDraft(
  input: WriteWorkflowDraftInput,
): Promise<{ path: string } | undefined> {
  if (input.cwd === undefined || input.cwd === "") return undefined;
  try {
    const dir = path.join(input.cwd, WORKFLOW_DRAFTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeDraftGitignore(dir);
    const slug = workflowDraftSlug(input.name);
    for (let attempt = 1; attempt <= WORKFLOW_DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const fileName = `${attempt === 1 ? slug : `${slug}-${attempt}`}${SAVED_WORKFLOW_FILE_EXTENSION}`;
      const filePath = path.join(dir, fileName);
      try {
        // `wx`：文件已在就报 EEXIST，于是"取名"与"占名"是同一个原子动作。
        await writeFile(filePath, input.source, { encoding: "utf8", flag: "wx" });
        return { path: filePath };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return undefined;
  } catch {
    // 尽力而为：目录写不进、`.zcode` 是个文件、盘满……一律当作「这次没有草稿」。调用方据此
    // 退回旧文案，工具调用本身照常完成。
    return undefined;
  }
}

/**
 * 草稿该叫什么：模型给的 `name` 优先；没有就取脚本第一个 `phase("…")` 的字面量——阶段是每个
 * 脚本都必须写的、且面向用户用用户语言写的（`CreateWorkflow` 描述的 Phases 规则），所以它是
 * 没有名字时最像名字的东西；连阶段都没有才落到兜底词。
 *
 * 刻意不用 run 标签的兜底（脚本首行）：实盘里首行多半是 `// ==== 结果类型 ====` 这种注释横幅。
 */
export function resolveWorkflowDraftName(
  name: string | undefined,
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string {
  if (name !== undefined && name.trim() !== "") return name;
  return createWorkflowPhaseNames(graph)?.[0] ?? WORKFLOW_DRAFT_FALLBACK_SLUG;
}

/**
 * 名字 → 文件名主干。空白连成 `-`，字母表（Unicode 字母 / 数字 / `_ . -`）之外的一概丢掉，
 * 截到上限（按码点，不按 UTF-16 单元，免得把一个字切成半个代理对）；什么都不剩、或只剩点
 * （`.` / `..` 是目录项，不是文件名）时用兜底词。
 */
export function workflowDraftSlug(name: string): string {
  const reduced = Array.from(
    name
      .trim()
      .replace(WORKFLOW_DRAFT_WHITESPACE_PATTERN, "-")
      .replace(WORKFLOW_DRAFT_SLUG_DROP_PATTERN, ""),
  )
    .slice(0, WORKFLOW_DRAFT_MAX_SLUG_CHARS)
    .join("")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (reduced === "" || /^\.+$/u.test(reduced)) return WORKFLOW_DRAFT_FALLBACK_SLUG;
  return reduced;
}

/** 草稿目录内的 `.gitignore`，只在缺席时写一次（用户改过就不再动它）。 */
async function writeDraftGitignore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
