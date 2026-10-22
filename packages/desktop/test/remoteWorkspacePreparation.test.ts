import { chmod, mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IFileService } from "@zcode/services";
import { createFileService } from "@zcode/services/node";
import { prepareRemoteWorkspaceIdentity } from "@desktop/host/remoteWorkspacePreparation.js";
import { createWindowRemoteConnectionRegistry } from "@desktop/host/windowRemoteConnectionRegistry.js";

const unavailableCode = "remote-workspace-directory-unavailable";
const target = { kind: "ssh" as const, host: "fixture.invalid", username: "tester" };
// 真实磁盘检查仅作为远端 File Service 的传输替身；生产函数不能直接读取控制端磁盘。
const fileService = createFileService();

describe.each([null, 0o000, 0o400, 0o100])(
  "远程工作区目录 admission，权限 %s（null 为删除）",
  (permissions) => {
    it.each(["manual", "automatic"] as const)(
      "%s：单个目录失效只拒绝该项目，修复后可以重连",
      async (mode, context) => {
        if (permissions !== null && (process.platform === "win32" || process.getuid?.() === 0)) {
          context.skip();
        }
        const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-workspace-admission-")));
        const paths = [1, 2, 3].map((n) => join(root, `workspace-${n}`));
        const closedListeners = new Set<
          (event: { exitCode: number | null; signal: string | null; recoverable: boolean }) => void
        >();
        const reconnectedListeners = new Set<() => void>();
        const bindIdentity = vi.fn(async (_input: { workspacePath: string }) => undefined);
        const sessionClosed = vi.fn();
        const connect = vi.fn(async () => ({
          services: fileService,
          onDidClose: (
            listener: (event: {
              exitCode: number | null;
              signal: string | null;
              recoverable: boolean;
            }) => void,
          ) => {
            closedListeners.add(listener);
            return { dispose: () => closedListeners.delete(listener) };
          },
          onDidReconnect: (listener: () => void) => {
            reconnectedListeners.add(listener);
            return { dispose: () => reconnectedListeners.delete(listener) };
          },
          dispose: async () => undefined,
        }));
        let id = 0;
        const registry = createWindowRemoteConnectionRegistry({
          connect,
          createId: () => `session-${++id}`,
          resolveSourceServerId: () => "fixture-source",
          prepareWorkspaceIdentity: (handle, input) =>
            prepareRemoteWorkspaceIdentity(handle.services, input, bindIdentity),
          onSessionClosed: sessionClosed,
          logicalReplacementRetryDelaysMs: [],
        });
        const connectPath = async (workspacePath: string) =>
          registry.connect({
            requestId: `request-${id}`,
            target,
            remoteAssets: {},
            workspacePath,
            workspaceIdentity: `remote:server:fixture-source:${workspacePath}`,
          });
        try {
          for (const path of paths) {
            await mkdir(path);
            await connectPath(path);
          }
          expect(connect).toHaveBeenCalledTimes(1);
          if (permissions === null) await rm(paths[0]!, { recursive: true });
          else {
            await chmod(paths[0]!, permissions);
            // 叶目录 stat 仍成功，不能用 mock EACCES 代替真正收回访问权限的场景。
            await expect(fileService.stat({ path: paths[0]! })).resolves.toMatchObject({
              type: "directory",
            });
          }
          bindIdentity.mockClear();
          for (const listener of closedListeners)
            listener({ exitCode: 0, signal: null, recoverable: mode === "automatic" });
          if (mode === "manual") {
            await expect(connectPath(paths[0]!)).rejects.toMatchObject({
              code: unavailableCode,
              retryable: false,
            });
            await connectPath(paths[1]!);
            await connectPath(paths[2]!);
          } else {
            for (const listener of reconnectedListeners) listener();
            await vi.waitFor(() =>
              expect(sessionClosed.mock.calls.some(([event]) => event.recoverable === false)).toBe(
                true,
              ),
            );
            expect(sessionClosed).toHaveBeenCalledWith(
              expect.objectContaining({ reasonCode: unavailableCode, retryable: false }),
            );
          }
          expect(bindIdentity.mock.calls.map(([input]) => input.workspacePath)).toEqual(
            paths.slice(1),
          );
          expect(
            registry
              .listSessions()
              .filter((session) => session.state === "online")
              .map((session) => session.workspacePath)
              .sort(),
          ).toEqual(paths.slice(1));
          if (permissions === null) {
            await expect(stat(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
            await mkdir(paths[0]!);
          } else await chmod(paths[0]!, 0o700);
          await expect(connectPath(paths[0]!)).resolves.toMatchObject({ workspacePath: paths[0] });
        } finally {
          await registry.dispose();
          if (permissions !== null) await chmod(paths[0]!, 0o700);
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);

describe("远程工作区目录 admission", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "可读取、可遍历但不可写的空目录仍可绑定",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-workspace-readonly-"));
      const bindIdentity = vi.fn();
      try {
        await chmod(root, 0o500);
        await prepareRemoteWorkspaceIdentity(
          fileService,
          {
            workspacePath: root,
            stableWorkspaceIdentity: `remote:server:fixture:${root}`,
          },
          bindIdentity,
        );
        expect(bindIdentity).toHaveBeenCalledTimes(1);
      } finally {
        await chmod(root, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("新目录绑定拒绝普通文件，且不执行身份写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-file-"));
    const path = join(root, "file");
    const bindIdentity = vi.fn();
    try {
      await writeFile(path, "fixture");
      await expect(
        prepareRemoteWorkspaceIdentity(
          fileService,
          { workspacePath: path, stableWorkspaceIdentity: "remote:server:fixture:/file" },
          bindIdentity,
        ),
      ).rejects.toMatchObject({ code: unavailableCode });
      expect(bindIdentity).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"])(
    "%s 映射为目录错误；无有效目录不执行身份写入",
    async (code) => {
      const bindIdentity = vi.fn();
      const remoteReaddir = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(
        prepareRemoteWorkspaceIdentity(
          { readdir: remoteReaddir },
          {
            workspacePath: "/remote/project",
            stableWorkspaceIdentity: "remote:server:fixture:/remote/project",
          },
          bindIdentity,
        ),
      ).rejects.toMatchObject({ code: unavailableCode, retryable: false });
      expect(bindIdentity).not.toHaveBeenCalled();
    },
  );

  it("网络错误保持原错误，取消后的迟到 readdir 不再写入身份", async () => {
    const input = {
      workspacePath: "/remote/project",
      stableWorkspaceIdentity: "remote:server:fixture:/remote/project",
    };
    const error = Object.assign(new Error("transport closed"), { code: "ECONNRESET" });
    const bindIdentity = vi.fn();
    await expect(
      prepareRemoteWorkspaceIdentity(
        { readdir: vi.fn().mockRejectedValue(error) },
        input,
        bindIdentity,
      ),
    ).rejects.toBe(error);
    let finish!: (value: Awaited<ReturnType<IFileService["readdir"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<IFileService["readdir"]>>>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const result = prepareRemoteWorkspaceIdentity(
      { readdir: () => pending },
      { ...input, signal: controller.signal },
      bindIdentity,
    );
    controller.abort();
    finish([]);
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(bindIdentity).not.toHaveBeenCalled();
  });

  it("取消 logical connect 后迟到的目录校验不得继续准备身份", async () => {
    let finish!: (value: Awaited<ReturnType<IFileService["readdir"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<IFileService["readdir"]>>>((resolve) => {
      finish = resolve;
    });
    const remoteReaddir = vi.fn(() => pending);
    const bindIdentity = vi.fn();
    const registry = createWindowRemoteConnectionRegistry({
      connect: async () => ({
        services: { readdir: remoteReaddir },
        dispose: async () => undefined,
      }),
      createId: () => "canceled-session",
      resolveSourceServerId: () => "fixture-source",
      prepareWorkspaceIdentity: (handle, input) =>
        prepareRemoteWorkspaceIdentity(handle.services, input, bindIdentity),
    });
    try {
      const result = registry.connect({
        requestId: "cancel-request",
        target,
        remoteAssets: {},
        workspacePath: "/remote/project",
      });
      const rejected = expect(result).rejects.toThrow();
      await vi.waitFor(() => expect(remoteReaddir).toHaveBeenCalledTimes(1));
      registry.cancelConnect("cancel-request");
      await rejected;
      finish([]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(bindIdentity).not.toHaveBeenCalled();
      expect(registry.listSessions()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });
});
