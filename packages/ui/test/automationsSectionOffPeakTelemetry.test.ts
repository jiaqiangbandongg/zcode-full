// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { IPlatformService, OffPeakTaskCreateResult } from "@zcode/shared";
import {
  buildOffPeakCreateResultTelemetryPayload,
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";

const automationsSectionSource = readFileSync(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
);

/** CR-01：闲时任务创建结果埋点接线必须从首页模板、Automations 模板、直接创建、灰度门禁失败 4 个入口
 * 各产生恰好 1 个 off_peak_task_create_result 事件。源契约保证接线不被悄悄删除；helper 行为
 * 在 packages/ui/test/offPeakTelemetry.test.ts 覆盖。 */
describe("AutomationsSection off-peak create telemetry wiring (CR-01)", () => {
  it("从 store 引入 OffPeakCreateDraft 类型", () => {
    expect(automationsSectionSource).toMatch(
      /import \{[\s\S]*?type OffPeakCreateDraft,?[\s\S]*?\} from "@\/store\/offPeakTaskStore\.js"/,
    );
  });

  it("从 offPeakTelemetry.js 引入全部 3 个 helper", () => {
    expect(automationsSectionSource).toContain("createAndReportOffPeakTask");
    expect(automationsSectionSource).toContain("freezeOffPeakCreateTelemetrySnapshot");
    expect(automationsSectionSource).toContain("reportOffPeakCreateResult");
    const importBlock = automationsSectionSource.match(
      /import \{[\s\S]*?\} from "@\/lib\/offPeakTelemetry\.js"/,
    );
    expect(importBlock).not.toBeNull();
  });

  it("AutomationsView 的 offpeak-create 模式使用 OffPeakCreateDraft 而非收窄的内联类型", () => {
    const offpeakCreateLine = automationsSectionSource.match(
      /mode: "offpeak-create";\s*draft\?: [^\n]+/,
    );
    expect(offpeakCreateLine).not.toBeNull();
    expect(offpeakCreateLine?.[0]).toContain("OffPeakCreateDraft");
    expect(offpeakCreateLine?.[0]).not.toContain("title?: string; prompt?: string");
  });

  it("Client Scenes idle template click 在 draft 上携带 telemetrySource（Automations 模板入口）", () => {
    const templateSection = automationsSectionSource.slice(
      automationsSectionSource.indexOf("data-automations-idle-templates"),
      automationsSectionSource.indexOf("data-automations-scheduled-templates"),
    );
    expect(templateSection).toContain("automationTemplates.offPeak.map");
    expect(templateSection).toContain('eventRegion: "app.automations"');
    expect(templateSection).toMatch(/templateId:\s*template\.id/);
  });

  it("handleOffPeakSubmit 顶部先 freezeOffPeakCreateTelemetrySnapshot", () => {
    const submitBlock = automationsSectionSource.match(
      /const handleOffPeakSubmit = useCallback\([\s\S]*?\n  \);/,
    );
    expect(submitBlock).not.toBeNull();
    expect(submitBlock?.[0]).toContain("freezeOffPeakCreateTelemetrySnapshot");
    expect(submitBlock?.[0]).toContain("current.draft?.telemetrySource");
    expect(submitBlock?.[0]).toContain("input.model");
    // 仅 offpeak-create 模式冻结 snapshot，offpeak-edit 走 offPeakUpdate 不需要埋点
    expect(submitBlock?.[0]).toMatch(
      /current\.mode === "offpeak-create"[\s\S]*?freezeOffPeakCreateTelemetrySnapshot/,
    );
  });

  it("灰度门禁失败时 fire-and-forget 上报 client_validation 结果", () => {
    const submitBlock = automationsSectionSource.match(
      /const handleOffPeakSubmit = useCallback\([\s\S]*?\n  \);/,
    );
    expect(submitBlock).not.toBeNull();
    expect(submitBlock?.[0]).toContain("reportOffPeakCreateResult");
    expect(submitBlock?.[0]).toContain('failureStage: "client_validation"');
    expect(submitBlock?.[0]).toContain('errorCategory: "client_validation"');
    // 防止阻塞主流程，必须 fire-and-forget
    expect(submitBlock?.[0]).toMatch(
      /void reportOffPeakCreateResult\(platform, telemetrySnapshot, \{/,
    );
    // 灰度门禁失败后立即 return false，不调用 offPeakCreate
    expect(submitBlock?.[0]).toMatch(/reportOffPeakCreateResult[\s\S]*?return false;/);
  });

  it("创建路径用 createAndReportOffPeakTask 包裹 offPeakCreate", () => {
    // 三元表达式：snapshot 非空走 createAndReportOffPeakTask，否则 fallback 到原 offPeakCreate
    const ternaryBlock = automationsSectionSource.match(
      /telemetrySnapshot !== null\s*\n\s*\?\s*await createAndReportOffPeakTask\([\s\S]*?offPeakCreate\(input, offPeakTaskService\)\s*,?\s*\)\s*\n\s*:\s*await offPeakCreate\(input, offPeakTaskService\)/,
    );
    expect(ternaryBlock).not.toBeNull();
    expect(ternaryBlock?.[0]).toContain("createAndReportOffPeakTask");
    expect(ternaryBlock?.[0]).toContain("offPeakCreate(input, offPeakTaskService)");
    // 必须用 platform + telemetrySnapshot 喂给 createAndReportOffPeakTask
    expect(ternaryBlock?.[0]).toMatch(
      /createAndReportOffPeakTask\(platform, telemetrySnapshot, \(\) =>/,
    );
  });

  it("useCallback 依赖列表包含 platform", () => {
    const submitBlock = automationsSectionSource.match(
      /const handleOffPeakSubmit = useCallback\([\s\S]*?\n  \);/,
    );
    expect(submitBlock).not.toBeNull();
    // 依赖块必须包含 platform；提交路径通过它上报
    expect(submitBlock?.[0]).toMatch(/\[[\s\S]*?platform,?[\s\S]*?\]/);
  });
});

/** Helper 行为在 offPeakTelemetry.test.ts 已覆盖；此处用同源类型做一次烟雾测试，
 * 防止 telemetry helper 自身意外回归导致接线看似存在实际不可用。 */
describe("offPeakTelemetry helpers used by AutomationsSection (smoke)", () => {
  const successResult = {
    ok: true,
    task: {
      offPeakTaskId: "offpeak-stable-1",
      serverTicketId: "forbidden-ticket",
      title: "forbidden title",
      prompt: "forbidden prompt",
      permissionMode: "build",
      workspaceKey: "/forbidden/workspace",
      workspacePath: "/forbidden/workspace",
      status: "queued",
      queuedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    ticketInitialState: "queued",
    providerName: "api.example.com",
  } satisfies OffPeakTaskCreateResult;

  it("首页模板来源 (eventRegion=app.session) freeze 后能产出正确 payload", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "standupGitSummary" },
      model: "GLM-5.2",
      providerId: "account:zai-offpeak-idle-plan",
    });
    expect(snapshot).toMatchObject({
      eventRegion: "app.session",
      templateId: "standupGitSummary",
      modelProvider: "offpeak-idle-plan",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, successResult);
    expect(payload.elementName).toBe("off_peak_task_create_result");
    expect(payload.eventRegion).toBe("app.session");
  });

  it("Automations 模板来源 (eventRegion=app.automations) freeze 后 templateId 透传", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
      model: "GLM-5.2",
    });
    expect(snapshot.templateId).toBe("ciFlakyReport");
    expect(snapshot.eventRegion).toBe("app.automations");
  });

  it("无 source 时回落到 app.automations + templateId=''（直接创建入口）", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" });
    expect(snapshot.eventRegion).toBe("app.automations");
    expect(snapshot.templateId).toBe("");
  });

  it("灰度门禁失败 payload 含 failure_stage=client_validation", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
      model: "GLM-5.2",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, {
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "",
      providerName: "",
    });
    expect(payload.eventExtraDetail).toMatchObject({
      result: "failure",
      failure_stage: "client_validation",
      error_category: "client_validation",
    });
  });

  it("createAndReportOffPeakTask 触发恰好一次 reportTelemetryEvent（best-effort 边界）", async () => {
    const reportTelemetryEvent = vi.fn(async () => undefined);
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    const create = vi.fn(async () => successResult);
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "standupGitSummary" },
      model: "GLM-5.2",
    });
    await createAndReportOffPeakTask(platform, snapshot, create);
    // fire-and-forget: 需要 microtask flush
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportTelemetryEvent).toHaveBeenCalledOnce();
  });

  it("reportOffPeakCreateResult reporter 拒绝被吞掉不抛", async () => {
    const reportTelemetryEvent = vi.fn().mockRejectedValue(new Error("network"));
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" });
    await expect(
      reportOffPeakCreateResult(platform, snapshot, successResult),
    ).resolves.toBeUndefined();
  });
});
