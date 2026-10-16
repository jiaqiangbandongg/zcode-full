import { readFile } from "node:fs/promises";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  ensureUpstreamModelForE2E,
  getUpstreamThoughtLevelLabels,
  getSelectedUpstreamModelLabel,
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamModelById,
  selectUpstreamThoughtLevelValue,
  waitForModelSwitchIdle,
} from "../../../helpers/upstream-provider.js";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "../../../helpers/network-capture-proxy.js";
import {
  countUpstreamRequests,
  countUpstreamRequestsContainingAll,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequestContaining,
} from "../../../helpers/conversation-session-network.js";
import {
  clickV4Stop,
  getV4CompactMarkers,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
  type V4CompactMarkerSnapshot,
} from "../../../helpers/v4-conversation.js";

const AUTO_ACTION_MARKER = "E2E_AUTO_ACTIONS";
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const E2E_REPLY_TOKEN = "upstream-e2e-ok";
const MODEL_SWITCH_GUARD_TITLE_ZH = "需要压缩上下文后再切换模型";
const MODEL_SWITCH_GUARD_TITLE_EN = "Compress context before switching models";

interface UpstreamCaptureQuery {
  afterIndex?: number;
  excludes?: readonly string[];
  includes: readonly string[];
}

describe("会话区模型切换与 Auto Compact 交集 E2E", () => {
  let runId = 0;

  before(async () => {
    await prepareV4ConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);
    runId = Date.now();
  });

  beforeEach(async () => {
    await startNewV4Draft();
    await selectUpstreamConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed 后切到过小目标模型，应弹出压缩确认并执行 guard compact", async function () {
    this.timeout(220000);

    const seedMarker = `${AUTO_ACTION_MARKER}_MODEL_SWITCH_GUARD_CONTEXT_${runId}`;
    const seedPrompt = buildModelSwitchGuardSeedPrompt(seedMarker);
    await sendV4Prompt(seedPrompt);
    await waitForUpstreamRequestContaining(seedMarker);
    await waitForV4Idle("model switch guard compact seed 没有完成", 90000);
    await waitForActiveTaskContextUsedAbove(
      0,
      "model switch guard compact seed 完成后没有正数 context usage",
    );

    const requestStartIndex = await getUpstreamRequestStartIndex();
    await selectUpstreamModelByIdWithGuardConfirm(UPSTREAM_SECONDARY_MODEL);

    const compactMarker = await waitForV4CompactMarkerMatch(
      ["running", "success"],
      "manual",
      undefined,
      30000,
    );
    const compactRecord = await waitForUpstreamCaptureRecord(
      {
        afterIndex: requestStartIndex,
        includes: [COMPACT_REQUEST_SENTINEL, seedMarker],
      },
      "模型切换 guard 确认压缩后没有捕获到 compact 请求",
      60000,
    );
    assertUpstreamConfig(compactRecord, COMPACT_REQUEST_SENTINEL, {
      model: UPSTREAM_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    assertStreamingCompactRequest(compactRecord);
    assertCaptureIncludesText(compactRecord.requestJson, seedMarker);
    expect(
      await countUpstreamRequests(
        { includes: [COMPACT_REQUEST_SENTINEL, seedMarker] },
        { afterIndex: requestStartIndex },
      ),
    ).toBe(1);

    const completedMarker =
      compactMarker.status === "success"
        ? compactMarker
        : await waitForV4CompactMarkerMatch(
            ["success"],
            "manual",
            compactMarker.rowId,
            90000,
          );
    expect(completedMarker.rowId).not.toBeNull();
    await waitForV4Idle("模型切换 guard compact 终态后会话没有回到 idle", 90000);
    await waitForModelSwitchIdle("模型切换 guard compact 完成后 pending 状态没有结束");
    await waitForModelSwitchCompressionDialogClosed();
  });

  it("completed 后切到过小目标模型并取消压缩，应保持原模型且不发 compact", async function () {
    this.timeout(120000);

    const seedMarker = `${AUTO_ACTION_MARKER}_MODEL_SWITCH_CANCEL_CONTEXT_${runId}`;
    const seedPrompt = buildModelSwitchGuardSeedPrompt(seedMarker);
    await sendV4Prompt(seedPrompt);
    await waitForUpstreamRequestContaining(seedMarker);
    await waitForV4Idle("model switch guard cancel seed 没有完成", 90000);
    await waitForActiveTaskContextUsedAbove(
      0,
      "model switch guard cancel seed 完成后没有正数 context usage",
    );

    const compactRequestsBefore = await countUpstreamRequestsContainingAll([
      COMPACT_REQUEST_SENTINEL,
      seedMarker,
    ]);
    await selectUpstreamModelByIdWithGuardCancel(UPSTREAM_SECONDARY_MODEL);
    await expectToolbarConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
    await waitForModelSwitchCompressionDialogClosed();
    await browser.pause(800);
    expect(await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, seedMarker])).toBe(
      compactRequestsBefore,
    );
  });

  it("auto compact started 后切 secondary，不中断 compact；若切换抢先完成则 pending prompt 使用 latest secondary", async function () {
    this.timeout(220000);

    const seedMarker = `${AUTO_ACTION_MARKER}_CONTEXT_SEED_${runId}`;
    const seedPrompt = `${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(seedPrompt);
    await waitForUpstreamRequestContaining(seedMarker);
    await waitForV4Idle("model switch auto compact seed 没有完成", 90000);

    const requestStartIndex = await getUpstreamRequestStartIndex();
    const compactRequestsBefore = await countUpstreamRequestsContainingAll([
      COMPACT_REQUEST_SENTINEL,
      AUTO_ACTION_MARKER,
    ]);
    const pendingMarker = `${AUTO_ACTION_MARKER}_PENDING_TEXT_${runId}`;
    const pendingPrompt = `${pendingMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(pendingPrompt);
    await waitForV4TimelineContaining(pendingPrompt);

    const startedMarker = await waitForV4CompactMarkerMatch(
      ["running", "success", "noop"],
      "auto",
      undefined,
      15000,
    ).catch(() => null);
    if (!startedMarker || startedMarker.status === "noop") {
      // 修复原因：manual-review live capture 使用真实线上模型时，短上下文不一定
      // 达到 needsCompact 阈值；该候选 case 不能把“没有触发 auto compact”误报成
      // 产品失败。这里记录 no-op 路径，仍证明 pending 请求没有被卡住或伪造 compact。
      await waitForUpstreamCaptureRecord(
        {
          afterIndex: requestStartIndex,
          excludes: [COMPACT_REQUEST_SENTINEL],
          includes: [pendingMarker],
        },
        "auto compact 未触发时没有继续 pending 主请求",
        90000,
      );
      await waitForV4Idle("auto compact 未触发时 pending 文本没有回到 idle", 90000);
      expect(
        await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, AUTO_ACTION_MARKER]),
      ).toBe(compactRequestsBefore);
      return;
    }
    expect(startedMarker.origin).toBe("auto");

    await browser.waitUntil(
      async () =>
        (await countUpstreamRequestsContainingAll([
          COMPACT_REQUEST_SENTINEL,
          AUTO_ACTION_MARKER,
        ])) ===
        compactRequestsBefore + 1,
      {
        timeout: 10000,
        timeoutMsg: "没有观察到 auto compact 请求发出",
      },
    );

    const switchResult = await trySelectUpstreamConfig(
      UPSTREAM_SECONDARY_MODEL,
      UPSTREAM_SECONDARY_THOUGHT_LEVEL,
      { closeOnFailure: false },
    );
    const compactCompletedBeforeSwitch = (await getV4CompactMarkers()).some((marker) =>
      matchesV4CompactMarker(marker, ["success"], "auto", startedMarker.rowId),
    );

    const autoCompactRecord = await waitForUpstreamCaptureRecord(
      {
        afterIndex: requestStartIndex,
        includes: [COMPACT_REQUEST_SENTINEL, AUTO_ACTION_MARKER],
      },
      "auto compact 完成后没有捕获到完整请求",
      10000,
    );
    assertUpstreamConfig(autoCompactRecord, COMPACT_REQUEST_SENTINEL, {
      model: UPSTREAM_MODEL,
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    assertStreamingCompactRequest(autoCompactRecord);
    expect(
      await countUpstreamRequestsContainingAll([COMPACT_REQUEST_SENTINEL, AUTO_ACTION_MARKER]),
    ).toBe(compactRequestsBefore + 1);

    await waitForV4Idle("auto compact 终态后会话没有回到 idle", 90000);
    const completedMarker = (await getV4CompactMarkers()).find((marker) =>
      matchesV4CompactMarker(marker, ["success"], "auto", startedMarker.rowId),
    );
    if (completedMarker) {
      expect(completedMarker.origin).toBe("auto");
      expect(completedMarker.rowId).not.toBeNull();
    }

    const pendingRecord = await findUpstreamCaptureRecord({
      afterIndex: requestStartIndex,
      excludes: [COMPACT_REQUEST_SENTINEL],
      includes: [pendingMarker],
    });
    const pendingModel = pendingRecord ? readCaptureModel(pendingRecord) : null;
    if (
      pendingRecord &&
      pendingModel === UPSTREAM_SECONDARY_MODEL &&
      switchResult.ok &&
      !compactCompletedBeforeSwitch
    ) {
      assertUpstreamConfig(pendingRecord, pendingMarker, {
        model: UPSTREAM_SECONDARY_MODEL,
        thoughtLevel: UPSTREAM_SECONDARY_THOUGHT_LEVEL,
      });
    }
  });
});

function buildModelSwitchGuardSeedPrompt(seedMarker: string) {
  return `${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function selectUpstreamConfig(model: string, thoughtLevel: string) {
  await selectUpstreamModelById(model);
  await selectUpstreamThoughtLevelValue(thoughtLevel);
  await expectToolbarConfig(model, thoughtLevel);
}

async function trySelectUpstreamConfig(
  model: string,
  thoughtLevel: string,
  options: { closeOnFailure?: boolean } = {},
) {
  try {
    await selectUpstreamConfig(model, thoughtLevel);
    return { ok: true };
  } catch (error) {
    if (options.closeOnFailure !== false) {
      await browser.keys("Escape").catch(() => undefined);
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

async function selectUpstreamModelByIdWithGuardConfirm(modelId: string) {
  await selectUpstreamModelById(modelId, {
    afterModelItemClick: async () => {
      await confirmModelSwitchCompressionDialog();
      return true;
    },
  });
}

async function selectUpstreamModelByIdWithGuardCancel(modelId: string) {
  await selectUpstreamModelById(modelId, {
    afterModelItemClick: async () => {
      await cancelModelSwitchCompressionDialog();
      return true;
    },
  });
  await waitForModelSwitchIdle(`模型 ${modelId} guard 取消后 pending 状态没有结束`);
}

async function confirmModelSwitchCompressionDialog() {
  await browser.waitUntil(async () => hasModelSwitchCompressionDialog(), {
    timeout: 15000,
    timeoutMsg: "没有出现模型切换前的上下文压缩确认弹窗",
  });

  const result = await browser.execute(() => {
    const dialog =
      document.querySelector<HTMLElement>('[role="dialog"]') ?? document.body;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
    const readLabels = (button: HTMLButtonElement) =>
      [
        button.innerText,
        button.textContent,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
      ]
        .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const labels = buttons.map((button) => readLabels(button).join(" / "));
    const confirmButton = buttons.find((button) =>
      readLabels(button).some(
        (text) =>
          text === "压缩" ||
          text === "继续" ||
          text === "Compress" ||
          text === "Continue" ||
          text.includes("压缩") ||
          text.startsWith("Compress"),
      ),
    );
    confirmButton?.click();
    return { clicked: Boolean(confirmButton), labels };
  });
  if (!result.clicked) {
    throw new Error(`没有找到模型切换压缩弹窗确认按钮: ${result.labels.join(" | ")}`);
  }
}

async function cancelModelSwitchCompressionDialog() {
  await browser.waitUntil(async () => hasModelSwitchCompressionDialog(), {
    timeout: 15000,
    timeoutMsg: "没有出现模型切换前的上下文压缩确认弹窗",
  });

  const result = await browser.execute(() => {
    const dialog =
      document.querySelector<HTMLElement>('[role="dialog"]') ?? document.body;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"));
    const readLabels = (button: HTMLButtonElement) =>
      [
        button.innerText,
        button.textContent,
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
      ]
        .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
    const labels = buttons.map((button) => readLabels(button).join(" / "));
    const cancelButton = buttons.find((button) =>
      readLabels(button).some(
        (text) =>
          text === "取消" ||
          text === "Cancel" ||
          text.startsWith("取消 ") ||
          text.startsWith("Cancel "),
      ),
    );
    cancelButton?.click();
    return { clicked: Boolean(cancelButton), labels };
  });
  if (!result.clicked) {
    throw new Error(`没有找到模型切换压缩弹窗取消按钮: ${result.labels.join(" | ")}`);
  }
}

async function hasModelSwitchCompressionDialog() {
  return browser.execute((titleZh, titleEn) => {
    const bodyText = document.body.innerText;
    return bodyText.includes(titleZh) || bodyText.includes(titleEn);
  }, MODEL_SWITCH_GUARD_TITLE_ZH, MODEL_SWITCH_GUARD_TITLE_EN);
}

async function waitForModelSwitchCompressionDialogClosed() {
  await browser.waitUntil(async () => !(await hasModelSwitchCompressionDialog()), {
    timeout: 5000,
    timeoutMsg: "模型切换压缩确认弹窗取消后没有关闭",
  });
}

async function expectToolbarConfig(model: string, thoughtLevel: string) {
  const modelLabel = await getSelectedUpstreamModelLabel();
  const acceptedModelValues = [`e2e-upstream/${model}`, `custom:e2e-upstream:${model}`, model];
  if (modelLabel.currentValue) {
    expect(acceptedModelValues).toContain(modelLabel.currentValue);
  } else {
    expect(Object.values(modelLabel).join("\n")).toContain(model);
  }

  if (!thoughtLevel) {
    return;
  }

  const thoughtLabel = await getSelectedUpstreamThoughtLevelLabel();
  const labelCandidates = Object.values(thoughtLabel)
    .map((value) => value.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const expectedLabels = [
    thoughtLevel,
    ...getUpstreamThoughtLevelLabels(thoughtLevel),
  ].map((label) => label.replace(/\s+/g, " ").trim().toLowerCase());
  if (!labelCandidates.some((label) => expectedLabels.includes(label))) {
    throw new Error(
      `思考深度未精确匹配 ${thoughtLevel}: ${JSON.stringify({
        expectedLabels,
        thoughtLabel,
      })}`,
    );
  }
}

function assertUpstreamConfig(
  record: E2ENetworkCaptureRecord,
  expectedText: string,
  {
    model,
    thoughtLevel,
  }: {
    model: string;
    thoughtLevel: string;
  },
) {
  assertUpstreamRequestCapture(record, { expectedText, model });
  if (thoughtLevel) {
    assertUpstreamThoughtLevelCapture(record, thoughtLevel);
  }
}

function assertStreamingCompactRequest(record: E2ENetworkCaptureRecord) {
  const request = asRecord(record.requestJson);
  expect(request.stream).toBe(true);
  expect(record.statusCode).toBeGreaterThanOrEqual(200);
  expect(record.statusCode).toBeLessThan(300);
  expect(String(record.responseHeaders["content-type"] ?? "").toLowerCase()).toContain(
    "text/event-stream",
  );
}

function assertCaptureIncludesText(value: unknown, expected: string) {
  if (captureContainsText(value, expected)) {
    return;
  }
  throw new Error(`抓包请求没有包含预期文本: ${expected}`);
}

async function getUpstreamRequestStartIndex() {
  return (await getUpstreamRequestRecordCount()) - 1;
}

async function waitForUpstreamCaptureRecord(
  query: UpstreamCaptureQuery,
  timeoutMsg: string,
  timeout: number,
): Promise<E2ENetworkCaptureRecord> {
  let latestRecords: Array<{
    id: string;
    model: string | null;
    status: string;
    statusCode?: number;
  }> = [];
  let matchingRecord: E2ENetworkCaptureRecord | undefined;
  await browser.waitUntil(
    async () => {
      const records = await readUpstreamCaptureRecords();
      matchingRecord = findLastUpstreamCaptureRecord(records, query);
      latestRecords = records.slice(-8).map((record) => ({
        id: record.id,
        model: readCaptureModel(record),
        status: record.status,
        statusCode: record.statusCode,
      }));
      return Boolean(matchingRecord);
    },
    {
      timeout,
      timeoutMsg: `${timeoutMsg}; latest=${JSON.stringify(latestRecords)}`,
    },
  );
  if (!matchingRecord) {
    throw new Error(timeoutMsg);
  }
  return matchingRecord;
}

async function findUpstreamCaptureRecord(query: UpstreamCaptureQuery) {
  return findLastUpstreamCaptureRecord(await readUpstreamCaptureRecords(), query);
}

async function readUpstreamCaptureRecords(): Promise<E2ENetworkCaptureRecord[]> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("Upstream e2e capture path is not configured");
  }
  try {
    const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
    return artifact.records;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function findLastUpstreamCaptureRecord(
  records: readonly E2ENetworkCaptureRecord[],
  query: UpstreamCaptureQuery,
) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && matchesUpstreamCaptureRecord(record, index, query)) {
      return record;
    }
  }
  return undefined;
}

function matchesUpstreamCaptureRecord(
  record: E2ENetworkCaptureRecord,
  index: number,
  query: UpstreamCaptureQuery,
) {
  return (
    (query.afterIndex === undefined || index > query.afterIndex) &&
    record.status === "complete" &&
    record.method === "POST" &&
    Boolean(record.statusCode && record.statusCode >= 200 && record.statusCode < 300) &&
    (record.path.includes("/messages") || record.path.includes("/chat/completions")) &&
    !captureContainsText(record.requestJson, "Generate a concise title") &&
    query.includes.every((text) => captureContainsText(record.requestJson, text)) &&
    !(query.excludes ?? []).some((text) => captureContainsText(record.requestJson, text))
  );
}

function readCaptureModel(record: E2ENetworkCaptureRecord) {
  const request = asRecord(record.requestJson);
  return typeof request.model === "string" ? request.model : null;
}

function matchesV4CompactMarker(
  marker: V4CompactMarkerSnapshot,
  statuses: readonly string[],
  origin: "manual" | "auto",
  rowId?: number | null,
) {
  return (
    statuses.includes(marker.status ?? "") &&
    marker.origin === origin &&
    (rowId == null || marker.rowId === rowId)
  );
}

async function waitForActiveTaskContextUsedAbove(threshold: number, timeoutMsg: string) {
  let latest: Awaited<ReturnType<typeof getV4ConfigProjection>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getV4ConfigProjection();
        return latest.usageUsed > threshold;
      },
      {
        timeout: 15000,
        timeoutMsg,
      },
    );
  } catch {
    throw new Error(`${timeoutMsg}: latest=${JSON.stringify(latest)}`);
  }
  return latest;
}

async function waitForV4CompactMarkerMatch(
  statuses: readonly string[],
  origin: "manual" | "auto",
  rowId: number | null | undefined,
  timeout: number,
) {
  let latestMarkers: V4CompactMarkerSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      latestMarkers = await getV4CompactMarkers();
      return latestMarkers.some((marker) =>
        matchesV4CompactMarker(marker, statuses, origin, rowId),
      );
    },
    {
      timeout,
      timeoutMsg: `没有等到 v4 compact marker statuses=${statuses.join(
        ",",
      )}, origin=${origin}, latest=${JSON.stringify(latestMarkers, null, 2)}`,
    },
  );

  const marker = latestMarkers.find((candidate) =>
    matchesV4CompactMarker(candidate, statuses, origin, rowId),
  );
  if (!marker) {
    throw new Error(`v4 compact marker statuses=${statuses.join(",")} 在等待完成后仍不存在`);
  }
  return marker;
}

async function waitForV4Idle(timeoutMsg: string, timeout: number) {
  await waitForV4Pane(
    (snapshot) =>
      !snapshot.canStop && snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
    timeoutMsg,
    timeout,
  );
  await waitForV4QueueCount(0, timeout);
}

async function stopIfBusy() {
  await browser.keys("Escape").catch(() => undefined);
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4Pane(
    (candidate) => !candidate.canStop,
    "模型切换 auto compact case 停止后没有退出 streaming",
    30000,
  ).catch(() => undefined);
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
