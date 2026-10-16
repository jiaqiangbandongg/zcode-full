// 终态通知载荷里的**用户面产物** chips（docs/dynamic-workflow/authoring.md「How the user sees them」）。
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，与同一载荷上的 `result`
// （脚本顶层返回值，引擎内部也叫 artifact）是两件不同的东西——见 spec 的「术语」表。
//
// 这份 schema 是三处必须同步的其中一处（另两处：contracts 的 TS 镜像、bootstrap 的
// `transcript-hydration.ts` 读取器）。它不是 `.strict()`——zod 默认**剥离**未声明的键，所以
// 「忘了在这里加字段」的症状不是报错，而是载荷在冷恢复后无声少一半。
import { describe, expect, it } from "vitest";
import {
  backgroundResultOriginMetaSchema,
  workflowNotificationMetaSchema,
} from "../src/zcode-protocol-v4/rows.js";

const terminal = (overrides: Record<string, unknown> = {}) => ({
  kind: "terminal" as const,
  status: "completed" as const,
  summary: "nightly audit",
  ...overrides,
});

describe("workflowNotificationMeta.terminal.artifacts", () => {
  it("接受 chips 需要的五个字段，title / contentType 可缺", () => {
    const parsed = workflowNotificationMetaSchema.parse(
      terminal({
        artifacts: [
          {
            id: "audit",
            kind: "file",
            title: "审计报告",
            version: 2,
            contentType: "application/pdf",
          },
          { id: "perf", kind: "chart", version: 1 },
        ],
      }),
    );
    expect(parsed.kind).toBe("terminal");
    expect(parsed.kind === "terminal" && parsed.artifacts).toEqual([
      { id: "audit", kind: "file", title: "审计报告", version: 2, contentType: "application/pdf" },
      { id: "perf", kind: "chart", version: 1 },
    ]);
  });

  it("两个字段一起缺席即「这个 run 没有产物」，不发空数组", () => {
    const parsed = workflowNotificationMetaSchema.parse(terminal());
    expect(parsed).not.toHaveProperty("artifacts");
    expect(parsed).not.toHaveProperty("artifactsTruncated");
  });

  it("artifactsTruncated 只能是 true（false 是每条载荷都要带的噪音字段）", () => {
    expect(
      workflowNotificationMetaSchema.parse(terminal({ artifacts: [], artifactsTruncated: true })),
    ).toMatchObject({ artifactsTruncated: true });
    expect(() =>
      workflowNotificationMetaSchema.parse(terminal({ artifactsTruncated: false })),
    ).toThrow();
  });

  it("上界 8 件：发射侧就地截断，超界整行落库时被拒", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `a${index + 1}`,
        kind: "markdown" as const,
        version: 1,
      }));
    expect(workflowNotificationMetaSchema.parse(terminal({ artifacts: entries(8) }))).toMatchObject(
      { kind: "terminal" },
    );
    expect(() =>
      workflowNotificationMetaSchema.parse(terminal({ artifacts: entries(9) })),
    ).toThrow();
  });

  it("kind 是闭集：未知种类让整份载荷被拒，所以发射侧必须先过滤", () => {
    expect(() =>
      workflowNotificationMetaSchema.parse(
        terminal({ artifacts: [{ id: "future", kind: "hologram", version: 1 }] }),
      ),
    ).toThrow();
    for (const kind of ["file", "markdown", "chart", "table", "metrics", "board"]) {
      expect(() =>
        workflowNotificationMetaSchema.parse(
          terminal({ artifacts: [{ id: "a", kind, version: 1 }] }),
        ),
      ).not.toThrow();
    }
  });

  it("id 非空 ≤64、title ≤120（= ARTIFACT_CAPS.maxTitleLength）、version 是正整数", () => {
    const one = (entry: Record<string, unknown>) => () =>
      workflowNotificationMetaSchema.parse(terminal({ artifacts: [entry] }));
    expect(one({ id: "", kind: "file", version: 1 })).toThrow();
    expect(one({ id: "x".repeat(65), kind: "file", version: 1 })).toThrow();
    expect(one({ id: "x".repeat(64), kind: "file", version: 1 })).not.toThrow();
    expect(one({ id: "a", kind: "file", version: 1, title: "t".repeat(121) })).toThrow();
    expect(one({ id: "a", kind: "file", version: 1, title: "t".repeat(120) })).not.toThrow();
    expect(one({ id: "a", kind: "file", version: 0 })).toThrow();
    expect(one({ id: "a", kind: "file", version: 1.5 })).toThrow();
  });

  // 交付物那一条例外地多带两个键（docs/dynamic-workflow/transcript-and-notifications.md
  // 「The deliverable row」）：完成卡要把它画成带文字的一行，冷 transcript 上只有这份载荷可读。
  it("primary 只能是 true；description 只在交付物上有意义，≤500（= ARTIFACT_CAPS.maxDescriptionLength）", () => {
    const one = (entry: Record<string, unknown>) => () =>
      workflowNotificationMetaSchema.parse(terminal({ artifacts: [entry] }));
    const deliverable = {
      id: "report",
      kind: "markdown",
      title: "审计报告",
      version: 3,
      primary: true,
      description: "本轮审计的结论与修复建议。",
    };
    const parsed = workflowNotificationMetaSchema.parse(terminal({ artifacts: [deliverable] }));
    expect(parsed.kind === "terminal" && parsed.artifacts).toEqual([deliverable]);
    // false 是每条都要带的噪音字段：缺席即「不是交付物」。
    expect(one({ id: "a", kind: "file", version: 1, primary: false })).toThrow();
    expect(one({ id: "a", kind: "file", version: 1, description: "d".repeat(500) })).not.toThrow();
    expect(one({ id: "a", kind: "file", version: 1, description: "d".repeat(501) })).toThrow();
  });

  it("载荷随 originMeta 一起过 schema（chips 的唯一数据源）", () => {
    const parsed = backgroundResultOriginMetaSchema.parse({
      backgroundSource: "workflow",
      workId: "dwfrun-1",
      title: "nightly audit",
      workflowNotification: terminal({
        artifacts: [{ id: "audit", kind: "file", version: 1 }],
        artifactsTruncated: true,
      }),
    });
    const meta = parsed.workflowNotification;
    expect(meta?.kind === "terminal" && meta.artifacts?.[0]?.id).toBe("audit");
    expect(meta?.kind === "terminal" && meta.artifactsTruncated).toBe(true);
  });

  // escalation 分支是另一支：它播报的是一个还没被满足的义务，与交付物无关。
  it("escalation 分支不长出 artifacts", () => {
    expect(() =>
      workflowNotificationMetaSchema.parse({
        kind: "escalation",
        qid: "dwfq-1",
        actor: "actor#1@1",
        question: "which branch?",
        artifacts: [{ id: "a", kind: "file", version: 1 }],
      }),
    ).not.toThrow();
    const parsed = workflowNotificationMetaSchema.parse({
      kind: "escalation",
      qid: "dwfq-1",
      actor: "actor#1@1",
      question: "which branch?",
      artifacts: [{ id: "a", kind: "file", version: 1 }],
    });
    // 未声明的键被剥离——escalation 载荷永远不带产物。
    expect(parsed).not.toHaveProperty("artifacts");
  });
});
