import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceHookBundleSnapshot } from "@zcode/contracts";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
} from "@zcode/shared/workspace-hook-discovery";
import { createWorkspaceHookReviewMutationPort } from "../src/app/workspace-hook-review-mutation.js";

const roots: string[] = [];
const runtimeRoot = {
  enabled: true,
  timeoutMs: 60_000,
  maxOutputBytes: 32_768,
};

function makeWorkspace(): { workspace: string; configPath: string } {
  const workspace = mkdtempSync(join(tmpdir(), "workspace-hook-review-mutation-"));
  roots.push(workspace);
  mkdirSync(join(workspace, ".git"));
  const configPath = join(workspace, ".zcode", "config.json");
  mkdirSync(join(workspace, ".zcode"));
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        projectSetting: "keep",
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                hooks: [{ type: "command", command: "echo reviewed", enabled: true }],
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { workspace, configPath };
}

async function snapshot(workspace: string) {
  const { sources, errors } = await readWorkspaceHookProjectSources({
    workingDirectory: workspace,
  });
  expect(errors).toEqual([]);
  const value = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: `local:${workspace}`,
    workspacePath: workspace,
    sources,
    runtimeRoot,
  });
  if (!value) throw new Error("expected snapshot");
  return createWorkspaceHookBundleSnapshot(value);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real workspace Hook review mutation port", () => {
  it("在同一 lock 内 preflight 当前 bundle、atomic write、commit callback、rebuild next snapshot", async () => {
    const { workspace, configPath } = makeWorkspace();
    const current = await snapshot(workspace);
    const events: string[] = [];
    const port = createWorkspaceHookReviewMutationPort({
      workingDirectory: workspace,
      workspaceIdentity: current.workspaceIdentity,
      runtimeRoot,
    });

    const next = await port.toggle(
      {
        snapshot: current,
        reviewItemId: current.hooks[0]!.reviewItemId,
        enabled: false,
      },
      () => {
        events.push("committed");
        expect(
          JSON.parse(readFileSync(configPath, "utf8")).hooks.events.SessionStart[0].hooks[0],
        ).toMatchObject({ command: "echo reviewed", enabled: false });
      },
    );

    expect(events).toEqual(["committed"]);
    expect(next.bundleDigest).not.toBe(current.bundleDigest);
    expect(next.hooks[0]).toMatchObject({
      declarationEnabled: false,
      configuredEnabled: false,
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).projectSetting).toBe("keep");
  });

  it("process-global workspace lock 使并发旧 bundle mutation 在第一份提交后 fail closed", async () => {
    const { workspace, configPath } = makeWorkspace();
    const current = await snapshot(workspace);
    const portA = createWorkspaceHookReviewMutationPort({
      workingDirectory: workspace,
      workspaceIdentity: current.workspaceIdentity,
      runtimeRoot,
    });
    const portB = createWorkspaceHookReviewMutationPort({
      workingDirectory: workspace,
      workspaceIdentity: current.workspaceIdentity,
      runtimeRoot,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = portA.toggle(
      {
        snapshot: current,
        reviewItemId: current.hooks[0]!.reviewItemId,
        enabled: false,
      },
      () => gate,
    );
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(configPath, "utf8")).hooks.events.SessionStart[0].hooks[0]
            .enabled,
      )
      .toBe(false);

    const second = portB.toggle(
      {
        snapshot: current,
        reviewItemId: current.hooks[0]!.reviewItemId,
        enabled: true,
      },
      () => undefined,
    );
    release();
    await expect(first).resolves.toMatchObject({
      hooks: [expect.objectContaining({ declarationEnabled: false })],
    });
    await expect(second).rejects.toMatchObject({
      // 第一次 toggle 已提交，bundle 确实变了：区别于 identity 不符与配置读失败，
      // 此处必须是 bundle_changed，用户才能据此判断是否重新审核。
      code: "workspace_hooks_bundle_changed",
    });

    // 该 message 会经 controller 进入 telemetry.errorMessage（TR27），因此不得含
    // 完整 digest 或绝对路径：spec §23.3「不上传完整 workspace path」、
    // §23.4「不记录 source path」。此前 message 内嵌完整 identity（即绝对路径）
    // 与全长 digest，构成明文泄漏。
    const rejection = await second.catch((error: unknown) => error);
    const message = rejection instanceof Error ? rejection.message : String(rejection);
    expect(message).not.toContain(configPath);
    // 摘要保留可诊断性：截断到 12 字符，但不出现全长（64 字符）digest。
    expect(message).toMatch(/expected [0-9a-f]{12}, got [0-9a-f]{12}/u);
    expect(message).not.toMatch(/[0-9a-f]{64}/u);

    expect(
      JSON.parse(readFileSync(configPath, "utf8")).hooks.events.SessionStart[0].hooks[0].enabled,
    ).toBe(false);
  });
});
