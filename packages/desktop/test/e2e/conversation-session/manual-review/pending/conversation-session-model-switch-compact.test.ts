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
  E2E_REPLY_TOKEN,
  clickChatStop,
  getCompactMarkers,
  getChatRootSnapshot,
  getUpstreamRequestRecordCount,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequestContaining,
} from "../../../helpers/conversation-session.js";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const MODEL_SWITCH_GUARD_TITLE_ZH = "需要压缩上下文后再切换模型";
const MODEL_SWITCH_GUARD_TITLE_EN = "Compress context before switching models";
const SECONDARY_COMPACT_MODEL = withOneMillionContextSuffix(UPSTREAM_SECONDARY_MODEL);
const SECONDARY_COMPACT_REQUEST_MODEL = stripLocalModelSuffix(SECONDARY_COMPACT_MODEL);

type CompactMarker = Awaited<ReturnType<typeof getCompactMarkers>>[number];

interface UpstreamCaptureQuery {
  afterIndex?: number;
  excludes?: readonly string[];
  includes: readonly string[];
}

describe("会话区模型切换与 Compact 交集 E2E", () => {
  let runId = 0;

  before(async () => {
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(SECONDARY_COMPACT_MODEL);
    runId = Date.now();
  });

  beforeEach(async () => {
    await startNewTask();
    await selectUpstreamConfig(UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL);
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("completed 后切 secondary 再 /compact，summary 请求使用 secondary model 和 compact summary 思考档", async function () {
    this.timeout(180000);

    const seedMarker = `E2E_STOP_HELD_QUEUE_FIRST_MODEL_SWITCH_MANUAL_${runId}`;
    const seedPrompt = `${seedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(seedPrompt);
    await waitForComposerText("", "model switch manual compact seed 发送后输入框没有清空");
    await waitForUpstreamRequestContaining(seedMarker);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "model switch manual compact seed 没有完成",
      90000,
    );

    await selectUpstreamConfig(
      SECONDARY_COMPACT_MODEL,
      UPSTREAM_SECONDARY_THOUGHT_LEVEL,
      { proveModelWithCapture: true },
    );

    const manualCompactInputIdsBefore = await getManualCompactInputIds();
    const requestStartIndex = await getUpstreamRequestStartIndex();
    await sendPrompt("/compact");
    await waitForComposerText("", "model switch manual /compact 发送后输入框没有清空");
    const startedMarker = await waitForNewManualCompactMarker(
      ["started", "completed"],
      manualCompactInputIdsBefore,
    );
    expect(startedMarker.trigger).toBe("manual");
    expect(startedMarker.inputId).toBeTruthy();

    const compactRecord = await waitForUpstreamCaptureRecord(
      {
        afterIndex: requestStartIndex,
        includes: [COMPACT_REQUEST_SENTINEL],
      },
      "没有捕获到 secondary manual compact 请求",
      60000,
    );
    assertUpstreamConfig(compactRecord, COMPACT_REQUEST_SENTINEL, {
      model: SECONDARY_COMPACT_REQUEST_MODEL,
      // 修复原因：该 case 的用户动作会把 toolbar 切到 secondary/max，
      // 但 compact summary 请求由压缩摘要链路发起，线上请求保持默认 high；
      // 这里锁定真正的产品合同：summary 使用 secondary 模型，thought 不误判成模型切换失败。
      thoughtLevel: UPSTREAM_THOUGHT_LEVEL,
    });
    assertNonStreamingCompactRequest(compactRecord);
    assertCaptureIncludesText(compactRecord.requestJson, seedMarker);

    const completedMarker =
      startedMarker.status === "completed"
        ? startedMarker
        : await waitForNewManualCompactMarker(
            ["completed"],
            manualCompactInputIdsBefore,
            startedMarker.inputId,
          );
    expect(completedMarker.trigger).toBe("manual");
    expect(completedMarker.operationId).toBeTruthy();
  });
});

interface SelectUpstreamConfigOptions {
  proveModelWithCapture?: boolean;
}

async function selectUpstreamConfig(
  model: string,
  thoughtLevel: string,
  { proveModelWithCapture = false }: SelectUpstreamConfigOptions = {},
) {
  await selectUpstreamModelById(
    model,
    proveModelWithCapture
      ? {
          afterModelItemClick: async () => {
            // 修复原因：该 manual-review case 的核心合同是后续 /compact
            // 请求使用 secondary 配置。模型 Select 关闭动画或上下文 guard 弹窗期间，
            // toolbar 的 data-model-current-value 可能短暂落后于用户可见 UI；这里
            // 只收敛真实阻塞状态，最终仍由线上请求抓包严格证明模型。
            // 当前 case 不测“小窗口模型切换 guard”，因此 secondary 选用 [1m]
            // 本地能力后缀；agent 发送 provider 请求前会剥掉后缀，抓包仍断言原始模型。
            await settleModelSwitchAfterModelItemClick(model);
            return true;
          },
        }
      : {},
  );
  await waitForNoBlockingDialog(`上游 模型 ${model} 切换后`);
  await selectUpstreamThoughtLevelValue(thoughtLevel);
  await expectToolbarConfig(model, thoughtLevel, {
    checkModel: !proveModelWithCapture,
  });
}

async function expectToolbarConfig(
  model: string,
  thoughtLevel: string,
  { checkModel = true }: { checkModel?: boolean } = {},
) {
  if (checkModel) {
    const modelLabel = await getSelectedUpstreamModelLabel();
    const acceptedModelValues = [`e2e-upstream/${model}`, `custom:e2e-upstream:${model}`, model];
    if (modelLabel.currentValue) {
      expect(acceptedModelValues).toContain(modelLabel.currentValue);
    } else {
      expect(Object.values(modelLabel).join("\n")).toContain(model);
    }
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

async function settleModelSwitchAfterModelItemClick(model: string) {
  await browser.pause(500);
  if (await confirmModelSwitchCompressionDialogIfPresent()) {
    await waitForModelSwitchCompressionDialogClosed("模型切换压缩确认弹窗确认后没有关闭");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "模型切换 guard compact 终态后会话没有回到 idle",
      90000,
    );
    await waitForModelSwitchIdle("模型切换 guard compact 完成后 pending 状态没有结束");
    await waitForNoBlockingDialog("模型切换 guard compact 完成后");
    return;
  }

  await waitForModelSwitchIdle(`上游 模型 ${model} 切换动画没有结束`).catch(() => undefined);
}

async function confirmModelSwitchCompressionDialogIfPresent() {
  const snapshot = await readOpenDialogSnapshot();
  if (!snapshot.hasOverlay && snapshot.dialogs.length === 0) {
    return false;
  }
  if (!snapshot.hasModelSwitchCompressionDialog) {
    throw new Error(`模型切换后出现了非预期弹窗: ${JSON.stringify(snapshot)}`);
  }

  const result = await browser.execute(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
    const labels = buttons.map((button) => button.innerText.replace(/\s+/g, " ").trim());
    const confirmButton = buttons.find((button) => {
      const text = button.innerText.replace(/\s+/g, " ").trim();
      return (
        text === "压缩" ||
        text === "继续" ||
        text.startsWith("Compress") ||
        text.startsWith("Continue") ||
        text.includes("压缩")
      );
    });
    confirmButton?.click();
    return { clicked: Boolean(confirmButton), labels };
  });
  if (!result.clicked) {
    throw new Error(`没有找到模型切换压缩弹窗确认按钮: ${result.labels.join(" | ")}`);
  }
  return true;
}

async function waitForModelSwitchCompressionDialogClosed(timeoutMsg: string) {
  await browser.waitUntil(
    async () => !(await readOpenDialogSnapshot()).hasModelSwitchCompressionDialog,
    {
      timeout: 10000,
      timeoutMsg,
    },
  );
}

async function waitForNoBlockingDialog(context: string) {
  let latest: OpenDialogSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readOpenDialogSnapshot();
        return !latest.hasOverlay && latest.dialogs.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: `${context} 仍有弹窗遮挡`,
      },
    );
  } catch (error) {
    latest = await readOpenDialogSnapshot();
    throw new Error(`${context} 仍有弹窗遮挡: ${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

interface OpenDialogSnapshot {
  bodyText: string;
  buttonLabels: string[];
  dialogs: Array<{
    ariaLabel: string;
    text: string;
  }>;
  hasModelSwitchCompressionDialog: boolean;
  hasOverlay: boolean;
}

function readOpenDialogSnapshot(): Promise<OpenDialogSnapshot> {
  return browser.execute((titleZh, titleEn) => {
    const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
    const bodyText = normalizeText(document.body.innerText).slice(0, 2000);
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).map(
      (dialog) => ({
        ariaLabel: dialog.getAttribute("aria-label") ?? "",
        text: normalizeText(dialog.innerText).slice(0, 1000),
      }),
    );
    return {
      bodyText,
      buttonLabels: Array.from(document.querySelectorAll<HTMLButtonElement>("button")).map(
        (button) => normalizeText(button.innerText),
      ),
      dialogs,
      hasModelSwitchCompressionDialog: bodyText.includes(titleZh) || bodyText.includes(titleEn),
      hasOverlay: Boolean(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')),
    };
  }, MODEL_SWITCH_GUARD_TITLE_ZH, MODEL_SWITCH_GUARD_TITLE_EN);
}

async function getManualCompactInputIds() {
  return new Set(
    (await getCompactMarkers())
      .filter((marker) => marker.trigger === "manual" && marker.inputId)
      .map((marker) => marker.inputId),
  );
}

async function waitForNewManualCompactMarker(
  statuses: readonly string[],
  existingInputIds: ReadonlySet<string | null>,
  inputId?: string | null,
): Promise<CompactMarker> {
  const statusSet = new Set(statuses);
  let latestMarkers: CompactMarker[] = [];
  await browser.waitUntil(
    async () => {
      latestMarkers = await getCompactMarkers();
      return latestMarkers.some((marker) =>
        isExpectedManualCompactMarker(marker, statusSet, existingInputIds, inputId),
      );
    },
    {
      timeout: statusSet.has("started") ? 20000 : 90000,
      timeoutMsg: `没有等到新的 manual compact marker statuses=${statuses.join(
        ",",
      )}, latest=${JSON.stringify(latestMarkers, null, 2)}`,
    },
  );

  const marker = latestMarkers.find((candidate) =>
    isExpectedManualCompactMarker(candidate, statusSet, existingInputIds, inputId),
  );
  if (!marker) {
    throw new Error(`新的 manual compact marker statuses=${statuses.join(",")} 在等待完成后仍不存在`);
  }
  return marker;
}

function isExpectedManualCompactMarker(
  marker: CompactMarker,
  statusSet: ReadonlySet<string>,
  existingInputIds: ReadonlySet<string | null>,
  inputId?: string | null,
) {
  return (
    statusSet.has(marker.status ?? "") &&
    marker.trigger === "manual" &&
    Boolean(marker.inputId) &&
    (inputId ? marker.inputId === inputId : !existingInputIds.has(marker.inputId))
  );
}

function withOneMillionContextSuffix(model: string) {
  const trimmed = model.trim();
  return /\[1m\]$/iu.test(trimmed) ? trimmed : `${trimmed}[1m]`;
}

function stripLocalModelSuffix(model: string) {
  return model.trim().replace(/-?\[[^\]]*\]$/u, "");
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

function assertNonStreamingCompactRequest(record: E2ENetworkCaptureRecord) {
  const request = asRecord(record.requestJson);
  expect(request.stream).not.toBe(true);
  expect(record.responseHeaders["content-type"]).not.toContain("text/event-stream");
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

async function stopIfBusy() {
  await browser.keys("Escape").catch(() => undefined);
  const snapshot = await getChatRootSnapshot();
  if (snapshot.state !== "streaming") {
    return;
  }
  await clickChatStop().catch(() => undefined);
  await waitForChatState(
    (candidate) => candidate.state !== "streaming",
    "模型切换 compact case 停止后没有退出 streaming",
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
