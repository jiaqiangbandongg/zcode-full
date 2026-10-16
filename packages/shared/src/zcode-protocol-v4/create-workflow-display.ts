// ============================================================
// CreateWorkflow 的工具卡 display 载荷（rows.ts 的 toolCallDisplaySchema 成员）
// ============================================================
// 从 rows.ts 拆出：workflow display + 因果图两段 schema 让 rows.ts 越过 max-lines 上限，
// 且它们是一块自洽的词汇表（与 workspace-hook-review.ts 同一先例——特性级 schema 单独成模块）。

import { z } from "zod";

// CreateWorkflow display 是独立于模型文本的有界投影；诊断条数与单条 message 长度都必须在
// 协议边界限长，避免类型检查结果把 continuous/replayable 消息扩成无界载荷。
// causalityGraph 同理：step / 车道 / 边的数量与标签长度在工具输出边界已限长，这里镜像
// 同一组上界。图的词汇表刻意很小：参与者卡 + 一种箭头（runs after，`back` 只标回边）+
// 阶段模块 + 返回物标记；分析器的 kind / certainty / exact / region 不进载荷。交接边是因果事实按子代理取商，阶段层
// 的边是控制流图的阶段商；step / 车道只作运行状态与检视器的键，不再画进图。
//
// 名字只在运行时成形（`` agent(`研究员${i + 1}`) ``）时静态能拿到的形状：第一个洞之前的
// 字面量（head）与最后一个洞之后的字面量（tail）。至少一个在场，两者都已 trim 且含实义字符。
// 只搬**数据**：渲染成「研究员…」的省略号由 name-pattern.ts 在渲染时加，投影里不存文案
// （与匿名兜底同一道理——见 lane-name.ts 头部）。
const namePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// 一条边 = runs after；交接边与阶段边同形。`back` 只标循环回边（布局排秩与 cycle 计数读），
// 画法与其他边相同。
const workflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const toolCallCreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            // `hole`：开着的留白自己的站点（docs/dynamic-workflow/presentation.md「Holes on the timeline」），
            // 车道恒为 `main`、阶段是留白自己的阶段（无成员）；run 的 `holes[]` 按 siteId 与它相接。
            // 与 contracts 的 CREATE_WORKFLOW_STEP_KINDS 同步。
            kind: z.enum(["ask", "world-read", "hole"]),
            label: z.string().min(1).max(128),
            // 内联 `agent()` receiver 让 label 落到兜底串时，那个名字的静态形状。
            labelPattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // 展开自的站点 id，只出现在 may-set 车道展开的拷贝上（实时叠加的关联键）；
            // 加字段是 additive 的，不带它的旧载荷照常通过 .strict()。
            source: z.string().min(1).max(64).optional(),
            // 作者用 `phase("…")` 标记划入的阶段。
            // 与图的 phases / phaseEdges / exits 同进同退：全在场或全缺席。
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
            // 这个站点是某次补全写进来的（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：
            // 值是那个留白的站点 id（名字键 `hole#<8 位十六进制>`）；留白**自己的**阶段 / 站上是包着它的
            // 留白（嵌套关系只在这里，id 里没有）。时间线据阶段上的同名键画补全的头与区域，step 上的这一份
            // 是检视器素材。additive：旧载荷不带它照常通过 .strict()。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // `name` 缺席而 agent() 首参是带洞的模板串时的静态形状；与 name 互斥。
            namePattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // 参与者 = 每阶段一张子代理卡（工作区 / 未解析同形）；数组顺序就是交接序，第一张是开局者。
    // fan-out 家族按字面量基数展开成 member，基数未知时一张 many 卡。
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    // 交接 = 参与者之间的 runs after；types 是跨越它的产物类型（检视器素材，不上箭头）。
    handoffs: z
      .array(
        workflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // 阶段词汇表：作者施加的分组结构，主画面以它为节点。与 phaseEdges / exits / Step.phase
    // 全有或全无——零标记脚本全缺席，UI 据此退回 step/车道视图。零成员阶段也在表里。
    // `unphased` 无 name，显示名由 UI 本地化。
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // 进入本阶段时还在跑的其他阶段（它们的 strand 尚未 join），阶段表序，不含自己，
            // 为空时缺席。是节点事实而不是边——控制没有从那里转移过来，所以不进 phaseEdges。
            // 时间轴据此把相邻阶段折成一条分叉的「带」，侧栏迷你轨道画成双线段。
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
            // 这个阶段是某次补全写进来的：值是那个留白的站点 id。时间线把同一个 `fill` 的连续几站折成
            // 一段「补全的头 + 区域」（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(workflowEdgeSchema).max(128).optional(),
    // 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：两端互为 alongside 的 data 边，
    // 只有 {from, to}——不是 runs after，不进 phaseEdges、不带 back。与词汇表同进同退。
    phaseStreams: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict())
      .max(128)
      .optional(),
    // 还开着的留白，源码序（docs/dynamic-workflow/authoring.md「Holes」）：一个留白就是一个阶段（id =
    // 站点 id、name = 字面量），所以它同时在 `phases` 里；这张表只补阶段表说不出的两件事——它是留白、
    // 它的类型原文——外加 `tail`（它是脚本的尾巴：轨道要在它之后多跑 40px 再淡出）。补全过的留白不在这里。
    holes: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            type: z.string().min(1).max(128),
            phase: z.string().min(1).max(64).optional(),
            tail: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    // 控制流可在其后正常完成的阶段（阶段视图的「阶段 → 返回物」箭头）；组内可为空数组。
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowCausalityGraph = z.infer<
  typeof toolCallCreateWorkflowCausalityGraphSchema
>;

export const toolCallCreateWorkflowDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: toolCallCreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
    // FillWorkflowHole 行补的是哪处留白（docs/dynamic-workflow/presentation.md「The fill row」）：站点 id、
    // **名字**、草稿路径与行号。行靠它给自己起名、卡的联接靠它累积头的标签——transcript 只存模型自己的
    // 入参，resolveInput 回填的 `hole` 块到不了行，所以名字必须随 display 走。成功与被拒都在场。
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolCallCreateWorkflowDisplay = z.infer<typeof toolCallCreateWorkflowDisplaySchema>;
