import { subagentUpdateCursor } from "./subagent-snapshot-wait.js";
import { readMessageTextBlocks } from "./subagent-listing-assertions.js";
import { readFile, readdir, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getE2EAppDataPaths } from "./desktop-app.js";
import {
  saveRefreshProfile,
  setRefreshProfileEnabled,
  deleteRefreshProfile,
  setRefreshModelOverride,
  type RefreshProfile,
} from "./subagent-refresh-settings.js";
import { getV4PaneSnapshot, sendV4PromptAndWaitAccepted, sendV4Prompt } from "./v4-conversation.js";
import { finishSubagentTurn } from "./subagent-refresh-conversation.js";
import {
  readSubagentCapture,
  assertSubagentProfile,
  readChildSessionIds,
  boundaryRpcReads,
} from "./subagent-refresh-capture.js";
import { setHostFaults, waitForHostBoundary, readHostBoundary } from "./subagent-host-window.js";
import {
  assertRequestCacheBreakpoint,
  assertParentRequestHistory,
  type CapturedPrompt,
} from "./provider-prefix.js";
import { assertUpstreamThoughtLevelCapture } from "./upstream-capture.js";
import { exportPromptTrajectory } from "./prompt-trajectory-export.js";
import { UPSTREAM_MODEL, UPSTREAM_THOUGHT_LEVEL } from "./upstream-provider.js";

type Peer = { handle: string; sessionId: string; hostPid: number; cliPid: number };
export async function exerciseSubagentHostBranches(
  peers: { a: Peer; b: Peer },
  base: RefreshProfile,
  updated: RefreshProfile,
) {
  const profilePath = join(getE2EAppDataPaths().storageRoot, "agents", `${base.name}.md`);
  const extraTurns = { a: 0, b: 0 };
  const previousListing: Record<string, string[]> = {};
  async function run(
    peer: "a" | "b",
    stage: string,
    expected: RefreshProfile | "missing" | "fallback" | "override" | "default",
    startOnly = false,
  ) {
    const target = peers[peer];
    await browser.switchToWindow(target.handle);
    const children = readChildSessionIds(target.sessionId);
    const beforeCount = (await readSubagentCapture()).filter(
      (r) => r.replay?.fixtureId === `shb-${stage}-final`,
    ).length;
    const marker = `E2E_SHB_${stage.toUpperCase()}`;
    const prompt = `${marker}: Execute the requested Agent verification for Host ${peer}.`;
    if (startOnly) await sendV4Prompt(prompt);
    else await sendV4PromptAndWaitAccepted(prompt, marker, `未接收 ${marker}`);
    extraTurns[peer]++;
    const finish = async () => {
      await finishSubagentTurn(`${marker}_DONE`, 60000);
      expect((await getV4PaneSnapshot()).sessionId).toBe(target.sessionId);
      const captured = await readSubagentCapture();
      const final = captured.filter((r) => r.replay?.fixtureId === `shb-${stage}-final`)[
        beforeCount
      ]!;
      expect(final?.status).toBe("complete");
      const body = final.requestJson as CapturedPrompt;
      const listing = readMessageTextBlocks(body)
        .filter((b) =>
          /(?:Available agent types|New agent types|The following agent types are no longer available)/u.test(
            b.text,
          ),
        )
        .map((b) => b.text);
      const changes: Record<string, [string, string[]]> = {
        add: ["New agent types", ["e2e-host-added"]],
        disabled: ["no longer available", ["e2e-host-added"]],
        reenabled: ["New agent types", ["e2e-host-renamed"]],
        renamed_old: ["no longer available", ["e2e-host-renamed", "e2e-host-final"]],
        deleted: ["no longer available", ["e2e-host-final"]],
      };
      if (previousListing[peer]) {
        const change = changes[stage];
        if (change) {
          expect(listing.slice(0, previousListing[peer].length)).toEqual(previousListing[peer]);
          expect(listing.length).toBeGreaterThan(previousListing[peer].length);
          const delta = listing.slice(previousListing[peer].length).join("\n");
          expect(delta).toContain(change[0]);
          for (const name of change[1]) expect(delta).toContain(name);
        } else if (expected === "fallback" || stage.endsWith("retried_b")) {
          expect(listing.slice(0, previousListing[peer].length)).toEqual(previousListing[peer]);
          expect(listing.length).toBeGreaterThan(previousListing[peer].length);
          expect(listing.slice(previousListing[peer].length).join("\n")).toContain(
            expected === "fallback" ? "no longer available" : "New agent types",
          );
        } else expect(listing).toEqual(previousListing[peer]);
      }
      previousListing[peer] = listing;
      const results = (
        body.messages.at(-1)!.content as Array<{
          type: string;
          tool_use_id: string;
          content: unknown;
          is_error?: boolean;
        }>
      ).filter((r) => r.type === "tool_result");
      if (expected === "missing" || expected === "fallback") {
        if (expected === "missing") expect(readChildSessionIds(target.sessionId)).toEqual(children);
        else {
          expect(readChildSessionIds(target.sessionId)).toHaveLength(children.length + 1);
          const child = captured.filter((r) => r.replay?.fixtureId === `shb-${stage}-child`)[
            beforeCount
          ]!;
          expect(child?.status).toBe("complete");
          expect(child.requestJson).toMatchObject({ model: UPSTREAM_MODEL });
          assertRequestCacheBreakpoint(child.requestJson as CapturedPrompt);
        }
        expect(results).toHaveLength(expected === "fallback" ? 3 : 2);
        for (const result of results.filter((r) => !r.tool_use_id.endsWith("_builtin"))) {
          expect(JSON.stringify(result.content)).toMatch(/not found|unavailable/u);
        }
        expect(results.find((r) => r.tool_use_id.endsWith("_spawn"))?.is_error).toBe(true);
      } else {
        expect(readChildSessionIds(target.sessionId)).toHaveLength(children.length + 1);
        const child = captured.filter((r) => r.replay?.fixtureId === `shb-${stage}-child`)[
          beforeCount
        ]!;
        expect(child?.status).toBe("complete");
        if (typeof expected === "object") assertSubagentProfile(child, expected);
        else {
          expect(child.requestJson).toMatchObject({
            model: expected === "override" ? updated.model : UPSTREAM_MODEL,
          });
          assertUpstreamThoughtLevelCapture(
            child,
            expected === "override" ? base.effort : UPSTREAM_THOUGHT_LEVEL,
          );
        }
        assertRequestCacheBreakpoint(child.requestJson as CapturedPrompt);
      }
      return final;
    };
    return startOnly ? finish : finish();
  }
  async function both(stage: string, expected: Parameters<typeof run>[2]) {
    await run("a", stage, expected);
    await run("b", stage, expected);
  }
  const save = async (peer: "a" | "b", profile: RefreshProfile, previous = profile.name) => {
    await browser.switchToWindow(peers[peer].handle);
    await saveRefreshProfile(profile, previous);
  };
  async function received(
    action: () => Promise<void>,
    pids = [peers.a.hostPid, peers.b.hostPid],
    changedPaths: string[] = [],
  ) {
    const updated = await subagentUpdateCursor();
    await action();
    await updated(pids, changedPaths);
  }
  // 双向保存由各 Host 的原生文件事件独立消费。
  let current = { ...base, prompt: "E2E_SHB_REVERSE_PROFILE" };
  await received(() => save("b", current));
  await both("reverse", current);

  let added = { ...updated, name: "e2e-host-added", prompt: "E2E_SHB_ADDED_PROFILE" };
  await received(async () => {
    await browser.switchToWindow(peers.a.handle);
    await saveRefreshProfile(added);
  });
  await both("add", added);
  added = {
    ...added,
    description: "Updated same-name description",
    prompt: "E2E_SHB_UPDATED_PROFILE",
  };
  await received(() => save("b", added));
  await both("update", added);
  await browser.switchToWindow(peers.b.handle);
  await received(() => setRefreshProfileEnabled(added.name, false));
  await both("disabled", "missing");
  const renamed = { ...added, name: "e2e-host-renamed" };
  await received(() => save("a", renamed, added.name), undefined, [`${renamed.name}.md`]);
  await both("renamed_disabled", "missing");
  await browser.switchToWindow(peers.b.handle);
  await received(() => setRefreshProfileEnabled(renamed.name, true));
  await both("reenabled", renamed);
  const finalName = { ...renamed, name: "e2e-host-final" };
  await received(() => save("a", finalName, renamed.name), undefined, [`${finalName.name}.md`]);
  await both("renamed_old", "missing");
  await both("renamed_new", finalName);
  await browser.switchToWindow(peers.b.handle);
  await received(() => deleteRefreshProfile(finalName.name));
  await both("deleted", "missing");

  for (const [name, id, tag] of [
    ["Explore", "Explore", "explore"],
    ["e2e-subagent-refresh:reviewer", "plugin:e2e-subagent-refresh@e2e-fixture:reviewer", "plugin"],
  ] as const) {
    await browser.switchToWindow(peers.a.handle);
    await received(() => setRefreshModelOverride(name, id, { ...updated, effort: base.effort }));
    await both(`override_${tag}`, "override");
    await browser.switchToWindow(peers.b.handle);
    await received(() => setRefreshModelOverride(name, id));
    await both(`clear_${tag}`, "default");
  }
  // 写盘失败：真实 UI 留在编辑表单，双方缓存/原文件不变，不发布持久化事件。
  const original = await readFile(profilePath, "utf8");
  await setHostFaults({
    files: [{ id: "save-failure", operation: "writeFile", path: profilePath, action: "fail" }],
  });
  await browser.switchToWindow(peers.b.handle);
  await saveRefreshProfile({ ...updated, name: base.name, prompt: "E2E_SHB_UNSAVED" }, base.name, {
    expectedError: "E2E writeFile failed",
  });
  expect(await readFile(profilePath, "utf8")).toBe(original);
  await setHostFaults({});
  await both("save_failed", current);

  // 外部编辑采用相同 watcher；重复快速写入只读最终文件，不扫描其他范围。
  const tracePaths = [
    profilePath,
    join(getE2EAppDataPaths().storageRoot, "agents"),
    join(getE2EAppDataPaths().storageRoot, "v2", "agents-state.json"),
    join(getE2EAppDataPaths().workspace, ".zcode", "agents"),
  ];
  await setHostFaults({ tracePaths });
  current = { ...current, prompt: "E2E_SHB_VALIDATED_PROFILE" };
  await received(async () => {
    const original = await readFile(profilePath, "utf8");
    const content = original.replace("E2E_SHB_REVERSE_PROFILE", current.prompt);
    await writeFile(profilePath, content + "\n");
    await writeFile(profilePath, content);
  });
  await both("duplicated", current);
  const configReads = async () => {
    const calls = (await readHostBoundary()).filter((r) => r.kind === "file-called");
    // 原生监听库为发现增删文件需要枚举目录；配置 loader 的目录扫描仍不允许。
    for (const call of calls.filter((r) => r.operation === "readdir"))
      expect(call.stack).toMatch(/ReaddirpStream/);
    return calls.filter((r) => r.operation !== "readdir");
  };
  const readsAfterReload = await configReads();
  expect(readsAfterReload).toHaveLength(1);
  expect(new Set(readsAfterReload.flatMap((r) => r.paths ?? []))).toEqual(new Set([profilePath]));
  await both("cache_hit", current);
  expect(await configReads()).toEqual(readsAfterReload);
  const unrelated = join(getE2EAppDataPaths().homeDir, "unrelated.md");
  await writeFile(unrelated, "external unrelated file");
  await both("unrelated_b", current);
  expect(await configReads()).toEqual(readsAfterReload);
  await setHostFaults({});

  // 文件读取失败：A 正常，B 自定义 spawn/resume 失败，但普通对话和内置 Agent 继续。
  await setHostFaults({
    files: [{ id: "read-failure", operation: "readFile", path: profilePath, action: "fail" }],
  });
  current = { ...current, prompt: "E2E_SHB_RETRY_PROFILE" };
  await received(() => save("a", current));
  await waitForHostBoundary("file-failed", "read-failure");
  await run("a", "read_ok_a", current);
  await run("b", "read_failed", "fallback");
  await setHostFaults({});
  await received(() =>
    (async () => {
      const content = await readFile(profilePath, "utf8");
      await writeFile(profilePath, content + "\n");
    })(),
  );
  await run("b", "read_retried_b", current);

  // 目录重建和全局 state 分别验证回退与事件恢复。
  for (const tag of ["directory", "state"] as const) {
    const path =
      tag === "state"
        ? join(getE2EAppDataPaths().storageRoot, "v2", "agents-state.json")
        : join(getE2EAppDataPaths().storageRoot, "agents");
    await setHostFaults({
      files: [
        { id: tag, operation: tag === "state" ? "readFile" : "readdir", path, action: "fail" },
      ],
    });
    await browser.switchToWindow(peers.a.handle);
    if (tag === "state")
      await received(() => setRefreshModelOverride("Explore", "Explore", updated));
    else {
      await received(async () => {
        const removed = await subagentUpdateCursor();
        await rename(path, path + "-saved");
        await removed([peers.a.hostPid, peers.b.hostPid], [path]);
        const recreated = await subagentUpdateCursor();
        await mkdir(path);
        for (const file of await readdir(path + "-saved"))
          await writeFile(join(path, file), await readFile(join(path + "-saved", file)));
        await rm(path + "-saved", { recursive: true });
        await recreated([peers.a.hostPid, peers.b.hostPid], [path]);
      });
    }
    await waitForHostBoundary("file-failed", tag);
    await run("a", `${tag}_ok_a`, current);
    await run("b", `${tag}_failed`, "fallback");
    await setHostFaults({});
    await received(async () => {
      const target = tag === "state" ? path : profilePath;
      const content = await readFile(target, "utf8");
      await writeFile(target, content + "\n");
    });
    await run("b", `${tag}_retried_b`, current);
    if (tag === "state") {
      await browser.switchToWindow(peers.a.handle);
      await received(() => setRefreshModelOverride("Explore", "Explore"));
    }
  }

  // 重载期间 RPC 立即返回旧快照；两次保存后迟到的旧读取成功/失败都不能覆盖最新结果。
  for (const rejection of [false, true]) {
    const id = rejection ? "stale_reject" : "stale_resolve";
    const readCount = Math.max(
      0,
      ...(await readHostBoundary()).map((r) => r.readCounts?.[profilePath] ?? 0),
    );
    await setHostFaults({
      tracePaths: [profilePath],
      files: [
        {
          id,
          path: profilePath,
          operation: "readFile",
          action: "hold",
          once: true,
          rejectAfterRelease: rejection,
        },
      ],
    });
    await received(() => save("a", { ...current, prompt: `E2E_SHB_${id}_OLD` }), [peers.a.hostPid]);
    await waitForHostBoundary("file-held", id);
    const expected = { ...current, prompt: `E2E_SHB_${id}_LATEST` };
    // 完整父子请求必须先完成，之后才释放文件屏障，证明对话没有等待后台 I/O。
    await run("b", id, current);
    expect((await readHostBoundary()).some((r) => r.kind === "file-released" && r.id === id)).toBe(
      false,
    );
    await received(() => save("a", expected), [peers.a.hostPid]);
    await setHostFaults({ released: [id], tracePaths: [profilePath] });
    await waitForHostBoundary("file-released", id);
    await browser.waitUntil(
      async () =>
        (await readHostBoundary()).some(
          (r) =>
            r.kind === "snapshot-published" && (r.readCounts?.[profilePath] ?? 0) >= readCount + 2,
        ),
      { timeout: 20000, timeoutMsg: "B 未完成两次写入后的配置更新" },
    );
    await run("b", `${id}_published`, expected);
    current = expected;
  }
  await setHostFaults({});
  // 初始化各一次，之后每个父 turn 一次配置 RPC；失败/迟到结果不增加 turn 或替换 CLI。
  for (const [key, peer] of Object.entries(peers) as Array<["a" | "b", Peer]>) {
    const reads = (await boundaryRpcReads()).filter(
      (r) => r.sessionId === peer.sessionId && r.kind === "read",
    );
    expect(reads).toHaveLength(1 + (key === "a" ? 2 : 6) + extraTurns[key]);
    expect(new Set(reads.map((r) => `${r.hostPid}/${r.pid}`))).toEqual(
      new Set([`${peer.hostPid}/${peer.cliPid}`]),
    );
    const all = (await readSubagentCapture())
      .filter((r) => {
        const id = r.replay?.fixtureId ?? "";
        return (
          (/^shi-.*(seed|tool|final|notification)$/u.test(id) ||
            /^shb-.*-(tool|final)$/u.test(id)) &&
          JSON.stringify(r.requestJson).includes(`E2E_SHI_${key.toUpperCase()}_SEED:`)
        );
      })
      .map((r) => r.requestJson as CapturedPrompt);
    expect(all).toHaveLength((key === "a" ? 3 : 10) + extraTurns[key] * 2);
    assertParentRequestHistory(all);
    const exported = await exportPromptTrajectory(peer.sessionId, `subagent-host-branches-${key}`);
    expect(exported.trajectories).toEqual([
      expect.objectContaining({ reason: "initial", requestCount: all.length }),
    ]);
  }
  return current;
}
