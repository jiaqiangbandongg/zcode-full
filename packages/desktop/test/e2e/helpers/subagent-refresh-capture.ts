import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getE2EAppDataPaths } from "./desktop-app.js";
import { assertUpstreamThoughtLevelCapture } from "./upstream-capture.js";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "./network-capture-proxy.js";
import type { RefreshProfile } from "./subagent-refresh-settings.js";
import { exportPromptTrajectory } from "./prompt-trajectory-export.js";
import {
  assertCompleteToolHistory,
  assertProviderMessageHistory,
  type CapturedPrompt,
} from "./provider-prefix.js";

export async function readSubagentCapture() {
  if (!process.env.E2E_PROVIDER_CAPTURE_PATH) throw new Error("Missing E2E_PROVIDER_CAPTURE_PATH");
  return (
    JSON.parse(
      await readFile(process.env.E2E_PROVIDER_CAPTURE_PATH!, "utf8"),
    ) as E2ENetworkCaptureArtifact
  ).records;
}
export async function waitForSubagentRequest(id: string, timeout = 120000) {
  let found: E2ENetworkCaptureRecord | undefined;
  await browser.waitUntil(
    async () => {
      found = (await readSubagentCapture()).find(
        (r) => r.replay?.fixtureId === id && r.status === "complete",
      );
      return Boolean(found);
    },
    { timeout, timeoutMsg: `未捕获 ${id}` },
  );
  return found!;
}
export function assertSubagentProfile(
  record: E2ENetworkCaptureRecord,
  profile: Pick<RefreshProfile, "model" | "effort" | "prompt" | "tools">,
) {
  expect(record.requestJson).toMatchObject({ model: profile.model });
  assertUpstreamThoughtLevelCapture(record, profile.effort);
  expect(JSON.stringify((record.requestJson as CapturedPrompt).system)).toContain(profile.prompt);
  expect(
    ((record.requestJson as CapturedPrompt).tools as Array<{ name: string }>).map((t) => t.name),
  ).toEqual([...profile.tools, "RespondToCoordinator"]);
}
/** 只读生产数据库；排序由原场景保留，不能靠测试 helper 改写 session。 */
export function readSubagentRows(sql: string, sessionId: string) {
  const db = new DatabaseSync(join(getE2EAppDataPaths().storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(sql).all(sessionId);
  } finally {
    db.close();
  }
}
export function readChildSessionIds(parent: string, order: "created" | "id" = "created") {
  return readSubagentRows(
    `SELECT id FROM session WHERE parent_id = ? AND task_type = 'subagent_child' ORDER BY ${order === "created" ? "time_created, id" : "id"}`,
    parent,
  ).map((r) => String(r.id));
}
export function readSubagentId(record: E2ENetworkCaptureRecord) {
  const id = [
    ...JSON.stringify(record.requestJson).matchAll(/agentId:\s*(agent_[A-Za-z0-9_-]+)/gu),
  ].at(-1)?.[1];
  expect(id).toBeTruthy();
  return id!;
}
export async function failBoundaryReads(sessionIds: string[]) {
  await writeFile(
    join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "subagent-config-control.json"),
    JSON.stringify({ failedSessionIds: sessionIds }),
  );
}
export async function boundaryRpcReads() {
  const root = process.env.ZCODE_E2E_ARTIFACT_DIR!;
  const paths = (await readdir(root)).filter((p) => /^subagent-config-rpc-\d+\.jsonl$/u.test(p));
  return (
    await Promise.all(
      paths.map(async (p) =>
        (await readFile(join(root, p), "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                time: number;
                pid: number;
                hostPid: number;
                cwd: string;
                kind: string;
                sessionId: string;
                failed?: boolean;
              },
          ),
      ),
    )
  ).flat();
}
export async function assertChildTrajectory(childId: string, ids: string[]) {
  const requests = await Promise.all(ids.map((id) => waitForSubagentRequest(id)));
  const bodies = requests.map((r) => r.requestJson as CapturedPrompt);
  for (const [index, body] of bodies.entries()) {
    assertCompleteToolHistory(body);
    if (index) assertProviderMessageHistory(bodies[index - 1]!, body);
  }
  const exported = await exportPromptTrajectory(
    childId,
    `subagent-boundary-child-${childId}`,
    "subagent",
  );
  expect(exported.trajectories).toHaveLength(1);
  expect(exported.trajectories.reduce((sum, t) => sum + t.requestCount, 0)).toBe(ids.length);
  // trajectory 按 messages 的追加关系分段；顶层 model/system/tools 变化本身不分段。
  expect(exported.trajectories.map((t) => t.reason)).toEqual(["initial"]);
}
