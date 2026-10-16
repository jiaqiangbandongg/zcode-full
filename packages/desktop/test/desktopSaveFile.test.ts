import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";

const mocks = vi.hoisted(() => ({
  agentOptions: [] as Array<{ connect?: { lookup?: Function } }>,
  copyFile: vi.fn(),
  dispatcherClose: vi.fn(),
  handler: null as ((event: unknown, payload: unknown) => Promise<unknown>) | null,
  fileClose: vi.fn(),
  fileWrite: vi.fn(),
  lookup: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  showSaveDialog: vi.fn(),
  undiciFetch: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: function Agent(options: { connect?: { lookup?: Function } }) {
    mocks.agentOptions.push(options);
    return { close: mocks.dispatcherClose };
  },
  fetch: mocks.undiciFetch,
}));

vi.mock("node:dns/promises", () => ({
  lookup: mocks.lookup,
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  ipcMain: {
    handle: vi.fn(
      (_channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
        mocks.handler = handler;
      },
    ),
  },
}));

vi.mock("node:fs/promises", () => ({
  copyFile: mocks.copyFile,
  mkdtemp: mocks.mkdtemp,
  open: vi.fn(async () => ({
    close: mocks.fileClose,
    write: mocks.fileWrite,
  })),
  rm: mocks.rm,
  writeFile: mocks.writeFile,
}));

describe("desktopSaveFile", () => {
  beforeEach(async () => {
    mocks.handler = null;
    mocks.agentOptions.length = 0;
    mocks.copyFile.mockReset();
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.dispatcherClose.mockReset();
    mocks.dispatcherClose.mockResolvedValue(undefined);
    mocks.fileClose.mockReset();
    mocks.fileClose.mockResolvedValue(undefined);
    mocks.fileWrite.mockReset();
    mocks.fileWrite.mockResolvedValue(undefined);
    mocks.mkdtemp.mockReset();
    mocks.mkdtemp.mockResolvedValue("/tmp/zcode-save-file-test");
    mocks.lookup.mockReset();
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    mocks.rm.mockReset();
    mocks.rm.mockResolvedValue(undefined);
    mocks.showSaveDialog.mockReset();
    mocks.undiciFetch.mockReset();
    mocks.writeFile.mockReset();
    vi.unstubAllGlobals();
    const { registerDesktopSaveFileIpcHandler } = await import("../src/main/desktopSaveFile.js");
    registerDesktopSaveFileIpcHandler({ warn: vi.fn() });
    expect(mocks.handler).not.toBeNull();
  });

  it("用户选定路径后把图片字节写入本地文件", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/cat.png",
    });
    const data = new Uint8Array([1, 2, 3]).buffer;

    await expect(
      mocks.handler?.({ sender: {} }, { data, suggestedName: "cat.png" }),
    ).resolves.toEqual({
      success: true,
      path: "/tmp/cat.png",
    });
    expect(mocks.writeFile).toHaveBeenCalledWith("/tmp/cat.png", new Uint8Array([1, 2, 3]));
  });

  it("用户取消另存为时不写入文件", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });
    const data = new Uint8Array([1]).buffer;

    await expect(
      mocks.handler?.({ sender: {} }, { data, suggestedName: "cat.png" }),
    ).resolves.toEqual({
      success: false,
      canceled: true,
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("在 main 进程流式下载无 CORS 的远程图片后写入用户路径", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/cat.png",
    });
    const reader = {
      cancel: vi.fn(async () => undefined),
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: true }),
    };
    mocks.undiciFetch.mockImplementation(async () => ({
      body: { getReader: () => reader },
      headers: new Headers({ "content-length": "3", "content-type": "image/png" }),
      ok: true,
      status: 200,
    }));

    await expect(
      mocks.handler?.(
        { sender: {} },
        { sourceUrl: "https://images.example.test/cat.png", suggestedName: "cat.png" },
      ),
    ).resolves.toEqual({
      success: true,
      path: "/tmp/cat.png",
    });
    expect(mocks.fileWrite).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    // Bugfix：被测代码用宿主 path.join(tempDir, "download") 拼下载中转文件，Windows 上
    // 分隔符是 `\`，而这里原来写死 POSIX 字面量，用例在 Windows 上必然失败。用宿主 join
    // 组装期望值，断言仍然表达同一个「临时目录下的 download 中转文件」。
    expect(mocks.copyFile).toHaveBeenCalledWith(
      join("/tmp/zcode-save-file-test", "download"),
      "/tmp/cat.png",
    );
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/zcode-save-file-test", {
      force: true,
      recursive: true,
    });
    expect(mocks.agentOptions[0]?.connect?.lookup).toBeTypeOf("function");
  });

  it("在读取远程响应前根据 Content-Length 拒绝超过 50 MiB 的图片", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/large.png",
    });
    const reader = { cancel: vi.fn(async () => undefined), read: vi.fn() };
    mocks.undiciFetch.mockImplementation(async () => ({
      body: { getReader: () => reader },
      headers: new Headers({ "content-length": String(50 * 1024 * 1024 + 1) }),
      ok: true,
      status: 200,
    }));

    await expect(
      mocks.handler?.(
        { sender: {} },
        { sourceUrl: "https://images.example.test/large.png", suggestedName: "large.png" },
      ),
    ).resolves.toEqual({
      success: false,
      error: "file_too_large",
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  it("对没有 Content-Length 的 chunked 响应在第 51 MiB 中止并清理", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/chunked-large.png",
    });
    const oneMiBChunk = new Uint8Array(1024 * 1024);
    let chunkIndex = 0;
    const reader = {
      cancel: vi.fn(async () => undefined),
      read: vi.fn(async () =>
        chunkIndex++ < 51 ? { done: false, value: oneMiBChunk } : { done: true },
      ),
    };
    mocks.undiciFetch.mockImplementation(async () => ({
      body: { getReader: () => reader },
      headers: new Headers(),
      ok: true,
      status: 200,
    }));

    await expect(
      mocks.handler?.(
        { sender: {} },
        {
          sourceUrl: "https://images.example.test/chunked-large.png",
          suggestedName: "chunked-large.png",
        },
      ),
    ).resolves.toEqual({
      success: false,
      error: "file_too_large",
    });
    expect(mocks.fileWrite).toHaveBeenCalledTimes(50);
    expect(reader.cancel).toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  it("拒绝直接访问本机或私网图片地址", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/private.png",
    });
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const fetchMock = vi.fn();
    mocks.undiciFetch.mockImplementation(fetchMock);

    await expect(
      mocks.handler?.(
        { sender: {} },
        { sourceUrl: "http://internal.example/cat.png", suggestedName: "cat.png" },
      ),
    ).resolves.toEqual({
      success: false,
      error: "remote_address_not_allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  });

  it("手动校验重定向目标并拒绝跳转到私网", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/redirect.png",
    });
    mocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const redirectBody = { cancel: vi.fn(async () => undefined) };
    const fetchMock = vi.fn(async () => ({
      body: redirectBody,
      headers: new Headers({ location: "http://metadata.internal/image.png" }),
      status: 302,
    }));
    mocks.undiciFetch.mockImplementation(fetchMock);

    await expect(
      mocks.handler?.(
        { sender: {} },
        { sourceUrl: "https://images.example.test/cat.png", suggestedName: "cat.png" },
      ),
    ).resolves.toEqual({
      success: false,
      error: "remote_address_not_allowed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redirectBody.cancel).toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("远程响应超过总超时时间后中止并清理", async () => {
    vi.useFakeTimers();
    try {
      mocks.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: "/tmp/slow.png",
      });
      mocks.undiciFetch.mockImplementation(
        (_url: URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      );

      const resultPromise = mocks.handler?.(
        { sender: {} },
        { sourceUrl: "https://images.example.test/slow.png", suggestedName: "slow.png" },
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toEqual({
        success: false,
        error: "write_failed",
      });
      expect(mocks.rm).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连接阶段只返回预检查通过的固定地址，忽略后续 DNS 重绑定", async () => {
    mocks.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/pinned.png",
    });
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const reader = {
      cancel: vi.fn(async () => undefined),
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array([1]),
        })
        .mockResolvedValueOnce({ done: true }),
    };
    mocks.undiciFetch.mockImplementation(async () => {
      const pinnedLookup = mocks.agentOptions[0]?.connect?.lookup;
      expect(pinnedLookup).toBeTypeOf("function");
      const connectedAddress = await new Promise<string>((resolve, reject) => {
        pinnedLookup?.(
          "images.example.test",
          { all: false },
          (error: Error | null, address: string) => (error ? reject(error) : resolve(address)),
        );
      });
      expect(connectedAddress).toBe("93.184.216.34");
      return {
        body: { getReader: () => reader },
        headers: new Headers({ "content-length": "1" }),
        ok: true,
        status: 200,
      };
    });

    await expect(
      mocks.handler?.(
        { sender: {} },
        { sourceUrl: "https://images.example.test/pinned.png", suggestedName: "pinned.png" },
      ),
    ).resolves.toEqual({ success: true, path: "/tmp/pinned.png" });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("注册到统一的平台频道", () => {
    expect(PlatformChannels.SaveFile).toBe("zcode:save-file");
  });
});
