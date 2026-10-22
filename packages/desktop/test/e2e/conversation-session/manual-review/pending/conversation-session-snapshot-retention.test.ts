// 生产 renderer 的独立 CDP E2E；使用 node:test，不能放入 WDIO/Docker preset。
// 前置：隔离 HOME 中播种 8 个 sess_probe_retention_0..7 已完成会话，启动未开启 E2E bridge 的 App。
// ZCODE_RETENTION_CDP_URL=http://127.0.0.1:9326 ZCODE_RETENTION_ARTIFACT_DIR=<dir>
// pnpm exec tsx --test packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-snapshot-retention.test.ts
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";

const prefix = "sess_probe_retention_";

interface HeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string | string[])[];
      edge_fields: string[];
      edge_types: (string | string[])[];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}

// 依据协议对象形状和测试 session 身份计数，不依赖压缩后的类名、变量名或跨快照 object id。
async function countRetainedHistory(path: string, activeSession: string) {
  const heap: HeapSnapshot = JSON.parse(await readFile(path, "utf8"));
  const meta = heap.snapshot.meta;
  const field = (fields: string[], key: string) => {
    const index = fields.indexOf(key);
    assert(index >= 0, `Heap schema missing ${key}`);
    return index;
  };
  const nf = {
    type: field(meta.node_fields, "type"),
    name: field(meta.node_fields, "name"),
    edge_count: field(meta.node_fields, "edge_count"),
  };
  const ef = {
    type: field(meta.edge_fields, "type"),
    name_or_index: field(meta.edge_fields, "name_or_index"),
    to_node: field(meta.edge_fields, "to_node"),
  };
  const nodeTypes = meta.node_types[nf.type] as string[];
  const edgeTypes = meta.edge_types[ef.type] as string[];
  const nw = meta.node_fields.length;
  const ew = meta.edge_fields.length;
  const name = (node: number) => heap.strings[heap.nodes[node + nf.name]!]!;
  let edge = 0;
  let snapshots = 0;
  let inactiveSnapshots = 0;
  let closedStores = 0;
  let liveStores = 0;
  const bySession: Record<string, number> = {};
  for (let node = 0; node < heap.nodes.length; node += nw) {
    const end = edge + heap.nodes[node + nf.edge_count]! * ew;
    if (nodeTypes[heap.nodes[node + nf.type]!] === "object") {
      const props: Record<string, number> = {};
      for (let pos = edge; pos < end; pos += ew) {
        if (edgeTypes[heap.edges[pos + ef.type]!] !== "property") continue;
        props[heap.strings[heap.edges[pos + ef.name_or_index]!]!] = heap.edges[pos + ef.to_node]!;
      }
      if (
        props.protocolVersion !== undefined &&
        props.rows !== undefined &&
        props.logEpoch !== undefined &&
        props.sessionId !== undefined &&
        name(props.sessionId).startsWith(prefix)
      ) {
        const session = name(props.sessionId);
        snapshots++;
        bySession[session] = (bySession[session] ?? 0) + 1;
        if (session !== activeSession) inactiveSnapshots++;
      }
      if (
        props.topic !== undefined &&
        props.state !== undefined &&
        props.transport !== undefined &&
        props.generation !== undefined &&
        props.closed !== undefined &&
        name(props.topic).includes(`/${prefix}`)
      ) {
        if (name(props.closed) === "true") closedStores++;
        else liveStores++;
      }
    }
    edge = end;
  }
  return { snapshots, inactiveSnapshots, closedStores, liveStores, bySession };
}

test(
  "SPR01: 136 session switches release inactive snapshots and closed stores",
  { timeout: 1_200_000 },
  async () => {
    const endpoint = process.env.ZCODE_RETENTION_CDP_URL;
    const artifactDir = process.env.ZCODE_RETENTION_ARTIFACT_DIR;
    assert(endpoint && artifactDir, "需要显式指定隔离 App CDP 与证据目录");
    const output = resolve(artifactDir);
    await mkdir(output, { recursive: true });
    const browser = await chromium.connectOverCDP(endpoint);
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes("/renderer/index.html"));
    assert(page, "缺少真实生产 renderer");
    const cdp = await page.context().newCDPSession(page);
    const measurements: Array<
      { name: string; switches: number; heapMiB: number } & Awaited<
        ReturnType<typeof countRetainedHistory>
      >
    > = [];
    let switches = 0;
    await cdp.send("HeapProfiler.enable");
    try {
      // 基线从 session 0 开始；随后固定按 1..7,0 循环。
      await page.getByTestId(`task-item-${prefix}7`).waitFor({ state: "visible" });
      const more = page.locator("[data-task-list-show-more]");
      for (const button of await more.all()) {
        if (await button.isVisible()) await button.click();
      }
      const select = async (index: number) => {
        await page.locator(`[data-testid="task-item-${prefix}${index}"]`).click();
        await page.waitForFunction(
          ({ prefix, index }) => {
            const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
            return (
              pane?.getAttribute("data-session-id") === `${prefix}${index}` &&
              pane.textContent?.includes(`RETENTION_REPLY_${index}`)
            );
          },
          { prefix, index },
          { timeout: 20_000 },
        );
        await pause(150);
      };
      await select(0);
      for (const [name, target] of [
        ["warmup-008", 8],
        ["switch-040", 40],
        ["switch-072", 72],
        ["switch-136", 136],
        ["idle-control", 136],
      ] as const) {
        while (switches < target) {
          await select((switches + 1) % 8);
          switches++;
          await appendFile(
            join(output, "switches.jsonl"),
            JSON.stringify({ switches, loaded: true }) + "\n",
          );
        }
        // 只在测试等待既有 30s keep-warm 到期；不改变产品回收策略。
        await pause(35_000);
        await cdp.send("Runtime.discardConsoleEntries");
        await cdp.send("HeapProfiler.collectGarbage");
        await pause(300);
        await cdp.send("HeapProfiler.collectGarbage");
        const usage = await cdp.send("Runtime.getHeapUsage");
        const path = join(output, `${name}.heapsnapshot`);
        const stream = createWriteStream(path);
        const chunk = ({ chunk }: { chunk: string }) => {
          stream.write(chunk);
        };
        cdp.on("HeapProfiler.addHeapSnapshotChunk", chunk);
        try {
          await cdp.send("HeapProfiler.takeHeapSnapshot", {
            reportProgress: false,
            captureNumericValue: true,
          });
        } finally {
          cdp.off("HeapProfiler.addHeapSnapshotChunk", chunk);
          await new Promise<void>((resolve, reject) => {
            stream.on("error", reject);
            stream.end(resolve);
          });
        }
        const counts = await countRetainedHistory(path, `${prefix}0`);
        const sample = { name, switches, heapMiB: usage.usedSize / 1048576, ...counts };
        measurements.push(sample);
        await writeFile(join(output, "measurements.json"), JSON.stringify(measurements, null, 2));
        await page.screenshot({ path: join(output, `${name}.png`) });
        console.log(JSON.stringify(sample));
      }
      // 先收齐 136 次及闲置对照，红灯时也保留完整曲线和堆快照。
      for (const sample of measurements) {
        assert.equal(sample.inactiveSnapshots, 0, `${sample.name}: 非当前会话 snapshot 未释放`);
        assert.equal(sample.closedStores, 0, `${sample.name}: 已关闭 store 未释放`);
        assert.equal(sample.liveStores, 1, `${sample.name}: 活跃会话 store 应只有一个`);
      }
    } finally {
      await cdp.send("HeapProfiler.disable");
      await cdp.detach();
      await browser.close();
    }
  },
);
