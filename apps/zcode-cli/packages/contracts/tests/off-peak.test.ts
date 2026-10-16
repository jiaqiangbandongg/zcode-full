import { describe, expect, it } from "vitest";
import {
  OffPeakCreateInputJsonSchema,
  OffPeakCreateInputSchema,
  OffPeakCreateOutputSchema,
  OffPeakListInputSchema,
  OffPeakTaskSummarySchema,
} from "../src/tools/off-peak.js";

describe("OffPeakCreateInputSchema（D49-4 参数面）", () => {
  it("title/prompt 必填，其余可选", () => {
    expect(
      OffPeakCreateInputSchema.safeParse({ title: "t", prompt: "p" }).success,
    ).toBe(true);
    expect(OffPeakCreateInputSchema.safeParse({ title: "t" }).success).toBe(false);
    expect(OffPeakCreateInputSchema.safeParse({ prompt: "p" }).success).toBe(false);
    expect(OffPeakCreateInputSchema.safeParse({ title: "  ", prompt: "p" }).success).toBe(false);
  });

  it("prompt 参数描述进入模型可见 schema，必须是 D50 绑定会话语义（机审 CR-01）", () => {
    const properties = (OffPeakCreateInputJsonSchema as { properties: Record<string, { description?: string }> })
      .properties;
    const description = properties.prompt?.description ?? "";
    expect(description).toContain("continues THIS conversation");
    expect(description).not.toMatch(/fresh|without relying|self-contained|NEW session/);
  });

  it("permissionMode 只接受产品四档词表", () => {
    for (const mode of ["build", "edit", "plan", "yolo"]) {
      expect(
        OffPeakCreateInputSchema.safeParse({ title: "t", prompt: "p", permissionMode: mode })
          .success,
      ).toBe(true);
    }
    expect(
      OffPeakCreateInputSchema.safeParse({
        title: "t",
        prompt: "p",
        permissionMode: "bypassPermissions",
      }).success,
    ).toBe(false);
  });

  it("strict：拒绝未知键（workspace/凭证不是模型入参）", () => {
    expect(
      OffPeakCreateInputSchema.safeParse({
        title: "t",
        prompt: "p",
        workspacePath: "/tmp",
      }).success,
    ).toBe(false);
  });
});

describe("OffPeak 输出与列表 schema", () => {
  it("任务快照最小面：不含 serverTicketId 等跨边界字段", () => {
    const parsed = OffPeakTaskSummarySchema.safeParse({
      offPeakTaskId: "offpeak-1",
      title: "t",
      status: "queued",
      queuePosition: 3,
      createdAt: 1,
      serverTicketId: "ticket-1",
    });
    expect(parsed.success).toBe(false);
  });

  it("create 输出 = task + message", () => {
    expect(
      OffPeakCreateOutputSchema.safeParse({
        task: { offPeakTaskId: "offpeak-1", title: "t", status: "queued", createdAt: 1 },
        message: "Created idle-time task offpeak-1.",
      }).success,
    ).toBe(true);
  });

  it("list 无参数", () => {
    expect(OffPeakListInputSchema.safeParse({}).success).toBe(true);
    expect(OffPeakListInputSchema.safeParse({ status: "queued" }).success).toBe(false);
  });
});
