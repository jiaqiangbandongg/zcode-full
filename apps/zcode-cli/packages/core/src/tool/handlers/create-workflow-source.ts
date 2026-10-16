// ============================================================
// CreateWorkflow - 入参的校验与归一化
// ============================================================
//
// 这个模块是**两条来源合流成一份脚本**的地方，也是全流程唯一一次读盘。合流点必须保持单一：
// 放回 handler 里，它会逐渐被 handler 的分支缠住，下一个人自然就会再开一条「保存的 run 特殊
// 处理」的岔路，而那条岔路的第一个受害者是确认窗——它会开始展示与将要执行的东西不同的字节。

import {
  CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR,
  CREATE_WORKFLOW_SOURCE_ERROR,
  CreateWorkflowInputSchema,
  type CreateWorkflowInput,
  type ModelCatalogPort,
  type SavedWorkflowArgsDeclaration,
  type SavedWorkflowScope,
} from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionResult } from "../types.js";
import { resolveModelReference } from "./model-reference.js";
import {
  listSavedWorkflows,
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "./saved-workflows/index.js";
import { writeWorkflowDraft } from "./workflow-drafts.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";

/** 业务失败的错误码，与既有 handler failure 惯例同一形状（确认窗调整的失败也用它）。 */
export const CREATE_WORKFLOW_FAILURE_CODE = 400;

function failure(message: string): ToolHandlerFailure {
  return { result: false, errorCode: CREATE_WORKFLOW_FAILURE_CODE, message };
}

/**
 * 来源三选一（外加「`args` 只跟 `path` 走」），只对**模型发出的**入参成立。
 *
 * 这条不能写进 zod：归一化之后 `script` 与 `saved` / `path` 同时在场是合法执行态，而 schema 会在
 * handler 的 parse 与 hook 改写后的二次校验上把它炸掉——且只在非内联路径上炸。
 */
export function validateCreateWorkflowSource(
  input: unknown,
): { result: true } | ToolHandlerFailure {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  // schema 本身的失败已由 executor 在更早的位置收口，这里只管 XOR。
  if (!parsed.success) return { result: true };
  const sources = [parsed.data.script, parsed.data.saved, parsed.data.path].filter(
    (source) => source !== undefined,
  );
  if (sources.length !== 1) return failure(CREATE_WORKFLOW_SOURCE_ERROR);
  // `args` 与 `path` 同进同退：`saved` 的实参走 `saved.args`，内联脚本没有声明可校验。静默
  // 忽略会让调用方以为参数生效了，而脚本读到的 `args` 是空的。
  if (parsed.data.args !== undefined && parsed.data.path === undefined) {
    return failure(CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR);
  }
  return { result: true };
}

/**
 * 并发上界的归一（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：向下取整、至少 1，
 * **没有上限**。默认并发 D 是起点不是天花板——用户要 40 个就是 40 个，高于 D 与低于 D 一样作数；
 * 真正替 provider 把关的是进程级治理器的 429 反馈，而不是机器核数。
 *
 * `CreateWorkflow`、`AmendWorkflow`、确认窗调整与 GUI 设置共用本函数：同一个数在几条路上归一出
 * 不同结果，是那种只会在用户改一次并发时才被发现的不一致。
 */
export function normalizeWorkflowMaxConcurrency(value: number): number {
  // 值已过 schema（正整数），下界仍然写出来：这个 helper 是几条路的共用入口，schema 换了
  // 也不该让 0、负数或小数穿过去（要「3.7 个在飞的 ask」没有意义，向上取整会偷偷越过用户说的数）。
  return Math.max(1, Math.floor(value));
}

/**
 * 子代理模型的归一化结果：解出来的规范形，或一个业务失败。
 *
 * 判别位用 `result` 而不是自造一个 `ok`：调用点要能把失败原样 `return` 出去，而
 * `ToolHandlerFailure` 的判别位就是 `result: false`。
 */
type SubagentModelResolution = { result: true; canonical?: string } | ToolHandlerFailure;

/**
 * 把 `subagent_model` 解析成规范形（`CreateWorkflow` 的那一半；`AmendWorkflow` 的三态在
 * amend-workflow.ts，两边共用 `resolveModelReference`）。
 *
 * 端口缺席而字段在场时**明确拒绝**，不静默放行：一个宿主解不了的字符串一路传下去，最后会
 * 在子代理第一次开口时炸——离用户按下确认已经很远，而且那时看起来像是模型的问题。
 */
function resolveCreateSubagentModel(
  requested: string | undefined,
  catalog: ModelCatalogPort | undefined,
): SubagentModelResolution {
  if (requested === undefined) return { result: true };
  if (catalog === undefined) return failure(SUBAGENT_MODEL_UNAVAILABLE);
  const resolution = resolveModelReference(requested, catalog.listModels());
  // 解不出来即整次调用失败：什么都没启动、确认窗也不开（与「保存的定义不存在」同一条路）。
  if (!resolution.ok) return failure(resolution.message);
  return { result: true, canonical: resolution.canonical };
}

/** 宿主没有模型目录时的拒绝文案（`AmendWorkflow` 共用，所以是常量而不是内联字符串）。 */
export const SUBAGENT_MODEL_UNAVAILABLE =
  "This host cannot choose a subagent model; omit subagent_model.";

/**
 * 把入参归一化成执行事实。内联来源是**恒等函数**（一次盘操作都不做）；saved 来源解析文件、
 * 校验实参、回填默认值、写下一份工作副本，产出 `{name, script, saved: {name, args, path, scope,
 * draft}}`；`path` 来源读那个文件（带元数据块就剥掉块并校验 `args`），产出
 * `{name, script, path, args?, script_line_offset?}`。
 *
 * 归一化后 `script` 一定在场，所以下游（hook、权限规则、prepareApproval、handler）对三条
 * 来源是同一段代码。`saved` / `path` 此后只是**来龙去脉**：run 标签的兜底、实参的持久化与
 * 脚本文件的记录读它们，执行一个字节都不读它们。
 *
 * `catalog` 是本机的模型目录（`context.modelCatalogPort`，缺席即不能选模型）。`max_concurrency` 与
 * `subagent_model` 都是顶层字段，三条来源同样处理。
 */
export async function resolveCreateWorkflowInput(
  input: unknown,
  cwd: string,
  catalog?: ModelCatalogPort,
): Promise<ToolInputResolutionResult> {
  const parsed = CreateWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };
  const model: CreateWorkflowInput = parsed.data;
  const requested = model.max_concurrency;

  // 模型解析排在读盘之前：三条来源同一段代码，而一次解不出来的调用不该先去扫一遍磁盘。
  const subagentModel = resolveCreateSubagentModel(model.subagent_model, catalog);
  if (!subagentModel.result) return subagentModel;
  const subagentModelField =
    subagentModel.canonical === undefined ? {} : { subagent_model: subagentModel.canonical };
  const boundField =
    requested === undefined ? {} : { max_concurrency: normalizeWorkflowMaxConcurrency(requested) };

  if (model.path !== undefined) {
    return resolvePathSource(model, model.path, cwd, {
      ...boundField,
      ...subagentModelField,
    });
  }

  // 内联：恒等。内联路径必须一次盘都不碰——那是「零回归」的可测形式。
  if (model.saved === undefined) {
    // 两个例外都是「改写它不读盘，不改写则确认窗显示的不是将要生效的东西」：需要取整的并发
    // 上界，和还没归一成规范形的模型名。两者都没动时仍然逐字节恒等。
    const normalized =
      requested === undefined ? undefined : normalizeWorkflowMaxConcurrency(requested);
    // 模型名比的是**原始**入参而不是 `model.subagent_model`：schema 带 `.trim()`，所以两端有
    // 空白的字符串解析出来与规范形相等，而恒等放行会让确认窗显示那串空白。
    const rawSubagentModel = (input as { subagent_model?: unknown } | null)?.subagent_model;
    if (normalized === requested && subagentModel.canonical === rawSubagentModel) {
      return { result: true, input };
    }
    return {
      result: true,
      input: {
        ...model,
        ...(normalized === undefined ? {} : { max_concurrency: normalized }),
        ...subagentModelField,
      } satisfies CreateWorkflowInput,
    };
  }

  const found = resolveSavedWorkflow({ cwd, name: model.saved.name, scope: model.saved.scope });
  if (!found.ok) return describeResolveFailure(model.saved.name, found, cwd, model.saved.scope);

  const validated = validateWorkflowArgs(found.meta.args, model.saved.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for saved workflow '${model.saved.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(`'${found.name}'`, found.meta.args),
      ].join("\n"),
    );
  }

  // 工作副本就在这一次读之后写下，写的是**刚读到的那串字节**（元数据块一起），所以不可能有
  // 第二次读与它分叉。定义本身永不因为一次 run 被改动：模型改的是这份拷贝
  const draft = await writeWorkflowDraft({
    cwd,
    name: model.name ?? found.name,
    source: found.source,
  });

  return {
    result: true,
    input: {
      // 未指定展示名时取保存的名字：跨会话枚举出来的 run 因此仍认得出是哪个工作流，而不是
      // 一串裸 runId。`readWorkflowName` 的既有读取规则（读 input.name）因此原样命中。
      name: model.name ?? found.name,
      // 逐字的脚本本体。旧桌面的 `readWorkflowScript(raw.script)` 因此**构造上**命中——
      // 不是兼容处理。
      script: found.script,
      saved: {
        name: found.name,
        args: validated.args,
        path: found.path,
        scope: found.scope,
        // 草稿写不下去时字段整个缺席（尽力而为），模型面随之退回旧文案。
        ...(draft === undefined ? {} : { draft: draft.path }),
      },
      // 拷贝逐字节带着元数据块，所以诊断的文件行要跳过块的那几行。
      ...(found.bodyLineOffset === 0 ? {} : { script_line_offset: found.bodyLineOffset }),
      ...boundField,
      // saved 分支是从零拼一份新入参的，所以每个顶层字段都要在这里被点名一次，否则它会被
      // 静默丢掉——而「只在 saved 路径上丢」是最难被发现的那种失效。
      ...subagentModelField,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * `path` 来源的归一化。
 *
 * 不写草稿：文件已经是工作副本了，再抄一份只会让模型下一次不知道该改哪一个。
 *
 * 带元数据块的文件按保存定义解析，`args` 按块里的声明校验（默认值一并补齐）；没有块的文件整个
 * 是脚本，此时给了 `args` 就是错——没有任何声明能校验它们，静默丢掉会让调用方以为参数生效了。
 */
async function resolvePathSource(
  model: CreateWorkflowInput,
  inputPath: string,
  cwd: string,
  extraFields: { max_concurrency?: number; subagent_model?: string },
): Promise<ToolInputResolutionResult> {
  const read = await readWorkflowScriptFile({ cwd, inputPath });
  if (!read.ok) return failure(read.message);
  const file = read.file;

  if (file.meta === undefined && model.args !== undefined) {
    return failure(
      `The workflow script file ${file.described} declares no arguments (it has no \`/* zcode-workflow\` metadata block), so it takes none. Drop \`args\`, or add a block declaring them.`,
    );
  }

  const validated = validateWorkflowArgs(file.meta?.args, model.args);
  if (!validated.ok) {
    return failure(
      [
        `The arguments for the workflow script file ${file.described} are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
        "",
        describeArgsDeclaration(file.described, file.meta?.args),
      ].join("\n"),
    );
  }

  return {
    result: true,
    input: {
      // 与 saved 分支同一条纪律：这里是从零拼一份新入参，每个顶层字段都要被点名一次。
      ...(model.name === undefined ? {} : { name: model.name }),
      script: file.script,
      path: file.path,
      // 声明为空时实参恒为 `{}`；不造空壳键，与内联 run 的「没有实参」保持同一种形状。
      ...(Object.keys(validated.args).length === 0 ? {} : { args: validated.args }),
      ...(file.bodyLineOffset === 0 ? {} : { script_line_offset: file.bodyLineOffset }),
      ...extraFields,
    } satisfies CreateWorkflowInput,
  };
}

/**
 * 解析失败的说明。找不到时**列出实际可用的名字**（带作用域标签）：模型猜错一个名字后最有用
 * 的下一步信息就是正确的那一批，否则它只会再猜一次。
 *
 * 找不到的文案分两档：给了 `scope` 说「该作用域下没有」，没给说「哪都没有」——两种都把两个
 * 档案里的名字都列出来，好让模型看清它要的那个是不是在另一档。
 */
function describeResolveFailure(
  name: string,
  found: Exclude<ReturnType<typeof resolveSavedWorkflow>, { ok: true }>,
  cwd: string,
  scope: SavedWorkflowScope | undefined,
): ToolHandlerFailure {
  if (found.reason === "invalid_name") {
    return failure(`'${name}' is not a usable workflow name: ${found.detail}`);
  }
  if (found.reason === "parse_error") {
    return failure(
      [
        `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
        "",
        "Its metadata block is malformed — most likely hand-edited. Fix the file, or save the workflow again.",
      ].join("\n"),
    );
  }
  if (found.reason === "read_error") {
    return failure(
      `The saved workflow '${name}' at ${found.path} could not be read: ${found.detail}`,
    );
  }

  const headline =
    scope === undefined
      ? `No saved workflow named '${name}' in this project or globally.`
      : `No ${scope} workflow named '${name}'.`;
  return failure(`${headline}\n\n${describeAvailableWorkflows(cwd)}`);
}

/**
 * 两个档案里实际可用的名字，各带作用域标签。定向扫每一根（不做遮蔽），好让被项目档遮蔽的
 * 全局定义也出现在清单里——模型据此才知道要拿它得指定 `scope: "global"`。
 */
function describeAvailableWorkflows(cwd: string): string {
  const project = listSavedWorkflows({ cwd, scope: "project" }).entries;
  const global = listSavedWorkflows({ cwd, scope: "global" }).entries;
  const tagged = [
    ...project.map((entry) => `${entry.name} (project)`),
    ...global.map((entry) => `${entry.name} (global)`),
  ];
  if (tagged.length === 0) {
    return "There are no saved workflows yet, in this project or globally. Use SaveWorkflow to create one, or pass an inline `script` instead.";
  }
  return `Available saved workflows: ${tagged.join(", ")}. Use ListSavedWorkflows for their descriptions.`;
}

/** 参数声明的紧凑复述，附在参数校验失败之后，好让模型一次改对而不是再猜一轮。 */
function describeArgsDeclaration(
  label: string,
  args: SavedWorkflowArgsDeclaration | undefined,
): string {
  const declared = Object.entries(args ?? {});
  if (declared.length === 0) return `${label} declares no arguments.`;
  return [
    `${label} declares:`,
    ...declared.map(([key, spec]) => {
      const notes = [
        spec.type,
        spec.required === true ? "required" : "optional",
        spec.default === undefined ? undefined : `default ${JSON.stringify(spec.default)}`,
      ].filter((note) => note !== undefined);
      return `- ${key} (${notes.join(", ")})${spec.description === undefined ? "" : `: ${spec.description}`}`;
    }),
  ].join("\n");
}
