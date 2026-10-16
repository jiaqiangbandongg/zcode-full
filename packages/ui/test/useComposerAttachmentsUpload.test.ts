import { act, createElement, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import type { PromptAttachmentTransferProgress } from "@zcode/services";
import {
  OversizedInlineImageAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachments.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import {
  COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS,
  isTransientAttachmentUploadError,
  useComposerAttachments,
  type ComposerAttachmentsApi,
} from "@/v4/composer/useComposerAttachments.js";

const mocks = vi.hoisted(() => ({
  platform: {
    canSelectFilePath: true,
    createTempTextAttachment: vi.fn(),
    getPathForFile: vi.fn(),
    selectFiles: vi.fn(async () => [] as string[]),
  },
  service: null as IPromptAttachmentTransferService | null,
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mocks.platform,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ promptAttachmentTransferService: mocks.service }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function createTransferService() {
  const listeners = new Map<string, Set<(event: PromptAttachmentTransferProgress) => void>>();
  const stage = vi.fn<IPromptAttachmentTransferService["stage"]>();
  const service: IPromptAttachmentTransferService = {
    adopt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    onDynamicProgress: (operationId) => (listener) => {
      const operationListeners = listeners.get(operationId) ?? new Set();
      operationListeners.add(listener);
      listeners.set(operationId, operationListeners);
      return { dispose: () => operationListeners.delete(listener) };
    },
    stage,
  };
  return {
    fire(operationId: string, event: Omit<PromptAttachmentTransferProgress, "operationId">) {
      for (const listener of listeners.get(operationId) ?? []) {
        listener({ operationId, ...event });
      }
    },
    service,
    stage,
  };
}

function createMinimalElement(ownerDocument: Document) {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    attributes: new Map<string, string>(),
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node) => element.appendChild(child),
    nodeName: "DIV",
    nodeType: 1,
    ownerDocument,
    parentNode: null,
    removeAttribute: (name: string) => element.attributes.delete(name),
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => element.attributes.set(name, value),
    style: {},
    tagName: "DIV",
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const documentMock = {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    createComment: () => ({ nodeType: 8, parentNode: null }),
    createElement: () => createMinimalElement(documentMock as unknown as Document),
    createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue, parentNode: null }),
    defaultView: null as unknown,
    nodeType: 9,
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
  };
  const windowMock = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    setTimeout,
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock as unknown as Document);
}

interface ProbeOptions {
  attachmentSessionId: string | null;
  localDesktop?: boolean;
  onRuntimeRestart?: (listener: () => void) => () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  remoteSessionId?: string | null;
  scopeId: string;
  workspaceIdentity?: string;
}

let latestApi: ComposerAttachmentsApi | null = null;

function Probe(options: ProbeOptions) {
  const remoteSessionId = options.localDesktop
    ? undefined
    : options.remoteSessionId === null
      ? undefined
      : (options.remoteSessionId ?? "remote-session-1");
  latestApi = useComposerAttachments({
    attachmentPut: vi.fn(),
    attachmentSessionId: options.attachmentSessionId,
    onRuntimeRestart: options.onRuntimeRestart,
    onRuntimeLifecycle: options.onRuntimeLifecycle,
    remoteSessionId,
    scopeId: options.scopeId,
    workspaceIdentity: options.localDesktop
      ? undefined
      : (options.workspaceIdentity ?? "remote:ssh:host:22:user:/workspace"),
    workspacePath: "/workspace",
  });
  return null;
}

function renderProbe(options: ProbeOptions) {
  const root = createRoot(installMinimalDom());
  act(() => root.render(createElement(Probe, options)));
  return {
    rerender(next: ProbeOptions) {
      act(() => root.render(createElement(Probe, next)));
    },
    root,
  };
}

async function addPaths(paths: string[]) {
  mocks.platform.selectFiles.mockResolvedValueOnce(paths);
  act(() => latestApi?.openAttachmentPicker());
  await vi.waitFor(() => expect(latestApi?.attachments).toHaveLength(paths.length));
}

function resultFor(operationId: string) {
  return {
    bytes: 100,
    operationId,
    ref: `/remote/${operationId}`,
    staged: true,
  };
}

beforeEach(() => {
  latestApi = null;
  mocks.platform.createTempTextAttachment.mockReset();
  mocks.platform.getPathForFile.mockReset();
  mocks.platform.selectFiles.mockReset();
  mocks.toast.mockClear();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});

afterEach(async () => {
  vi.useRealTimers();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
  // React 19 的 scheduler 可能在 root.unmount() 后仍留有一个 setImmediate 回调。
  // 必须先让它在 DOM shim 仍存在时排空，否则测试结束删除 window 后会产生 unhandled error。
  await new Promise<void>((resolve) => setImmediate(resolve));
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("useComposerAttachments eager upload", () => {
  it("满 8 个后每次粘贴都提示，且点击添加不再打开文件选择器", async () => {
    mocks.service = createTransferService().service;
    const { root } = renderProbe({
      attachmentSessionId: null,
      scopeId: "full-limit",
      localDesktop: true,
    });
    mocks.platform.selectFiles.mockResolvedValueOnce(
      Array.from({ length: 8 }, (_, index) => `/workspace/${index}.txt`),
    );
    await act(async () => latestApi?.openAttachmentPicker());
    mocks.platform.selectFiles.mockClear();

    act(() => latestApi?.openAttachmentPicker());
    expect(mocks.platform.selectFiles).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      "chat.attachments.maxFiles",
      expect.objectContaining({ variant: "warning" }),
    );

    for (let index = 0; index < 2; index++) {
      act(() =>
        latestApi?.handlePaste({
          clipboardData: {
            files: [new File(["extra"], "extra.txt")],
            types: ["Files"],
            getData: () => "",
          } as unknown as DataTransfer,
          preventDefault: vi.fn(),
        }),
      );
    }
    expect(mocks.toast).toHaveBeenCalledTimes(3);
    expect(latestApi?.attachments).toHaveLength(8);
    expect(latestApi?.attachments.some((item) => item.filename === "extra.txt")).toBe(false);

    act(() => latestApi?.removeAttachment(latestApi.attachments[0]!.id));
    mocks.platform.selectFiles.mockResolvedValueOnce(["/workspace/replacement.txt"]);
    await act(async () => latestApi?.openAttachmentPicker());
    await vi.waitFor(() => expect(latestApi?.attachments).toHaveLength(8));
    expect(mocks.platform.selectFiles).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(3);
    act(() => root.unmount());
  });

  it("剩 1 个名额时选择 2 个，只接收第 1 个并弹出超限提示", async () => {
    mocks.service = createTransferService().service;
    const { root } = renderProbe({
      attachmentSessionId: null,
      scopeId: "partial-limit",
      localDesktop: true,
    });
    mocks.platform.selectFiles.mockResolvedValueOnce(
      Array.from({ length: 7 }, (_, index) => `/workspace/${index}.txt`),
    );
    await act(async () => latestApi?.openAttachmentPicker());
    mocks.platform.selectFiles.mockResolvedValueOnce([
      "/workspace/accepted.txt",
      "/workspace/rejected.txt",
    ]);
    await act(async () => latestApi?.openAttachmentPicker());
    await vi.waitFor(() => expect(latestApi?.attachments).toHaveLength(8));
    expect(latestApi?.attachments.at(-1)?.filename).toBe("accepted.txt");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "chat.attachments.maxFiles",
      expect.objectContaining({ variant: "warning" }),
    );
    act(() => root.unmount());
  });

  it("只把 video inline 超限视为不可重试，不改变 image 的既有重试判定", () => {
    const options = { filename: "media.bin", maxSizeBytes: 1, sizeBytes: 2 };

    expect(isTransientAttachmentUploadError(new OversizedInlineVideoAttachmentError(options))).toBe(
      false,
    );
    expect(isTransientAttachmentUploadError(new OversizedInlineImageAttachmentError(options))).toBe(
      true,
    );
  });

  it("Excel 多表示剪贴板优先保留文本，不把合成 PNG 加为附件", () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const { root } = renderProbe({ attachmentSessionId: null, scopeId: "excel-paste" });
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const image = new File(["preview"], "image.png", { type: "image/png" });

    act(() =>
      latestApi?.handlePaste({
        clipboardData: {
          files: [image],
          getData: (type: string) => {
            if (type === "text/plain") return "姓名\t数量\n苹果\t2";
            if (type === "text/html") {
              return '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><table></table>';
            }
            return "";
          },
          types: ["text/plain", "text/html", "Files"],
        } as unknown as DataTransfer,
        preventDefault,
        stopPropagation,
      }),
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(latestApi?.attachments).toEqual([]);
    act(() => root.unmount());
  });

  it("Excel 超长文本仍转 clipboard-text 附件，不退回合成 PNG", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    mocks.platform.createTempTextAttachment.mockResolvedValue({
      filename: "pasted-text.txt",
      localPath: "/tmp/pasted-text.txt",
      mimeType: "text/plain",
      sizeBytes: 15_361,
    });
    const { root } = renderProbe({ attachmentSessionId: null, scopeId: "excel-long-paste" });
    const preventDefault = vi.fn();
    const text = `${"A".repeat(15_359)}\tB`;

    act(() =>
      latestApi?.handlePaste({
        clipboardData: {
          files: [new File(["preview"], "image.png", { type: "image/png" })],
          getData: (type: string) => (type === "text/plain" ? text : ""),
          types: ["text/plain", "Files"],
        } as unknown as DataTransfer,
        preventDefault,
        stopPropagation: vi.fn(),
      }),
    );

    await vi.waitFor(() => expect(latestApi?.attachments).toHaveLength(1));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(latestApi?.attachments[0]).toMatchObject({
      filename: "pasted-text.txt",
      mimeType: "text/plain",
      sourceKind: "clipboard-text",
    });
    act(() => root.unmount());
  });

  it("截图和真实 xlsx 文件仍按附件处理", () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const { root } = renderProbe({ attachmentSessionId: null, scopeId: "real-file-paste" });
    const screenshotPreventDefault = vi.fn();

    act(() =>
      latestApi?.handlePaste({
        clipboardData: {
          files: [new File(["png"], "screenshot.png", { type: "image/png" })],
          getData: () => "",
          types: ["Files"],
        } as unknown as DataTransfer,
        preventDefault: screenshotPreventDefault,
        stopPropagation: vi.fn(),
      }),
    );
    expect(screenshotPreventDefault).toHaveBeenCalledOnce();
    expect(latestApi?.attachments.map((item) => item.filename)).toEqual(["screenshot.png"]);

    act(() => latestApi?.clearAttachments());
    const xlsxPreventDefault = vi.fn();
    act(() =>
      latestApi?.handlePaste({
        clipboardData: {
          files: [
            new File(["xlsx"], "book.xlsx", {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }),
          ],
          getData: (type: string) => (type === "text/plain" ? "/tmp/book.xlsx" : ""),
          types: ["text/plain", "Files"],
        } as unknown as DataTransfer,
        preventDefault: xlsxPreventDefault,
        stopPropagation: vi.fn(),
      }),
    );
    expect(xlsxPreventDefault).toHaveBeenCalledOnce();
    expect(latestApi?.attachments.map((item) => item.filename)).toEqual(["book.xlsx"]);
    act(() => root.unmount());
  });

  it("兼容只暴露 Files type 的 dragover，并保留 workspace/attachment 分类", () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const { root } = renderProbe({ attachmentSessionId: null, scopeId: "task-a" });
    const preventDefault = vi.fn();
    const attachmentTransfer = {
      dropEffect: "none",
      items: [],
      types: ["Files"],
    };

    act(() =>
      latestApi?.handleDragOverComposer({
        dataTransfer: attachmentTransfer,
        preventDefault,
      } as unknown as DragEvent<HTMLElement>),
    );
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(attachmentTransfer.dropEffect).toBe("copy");
    expect(latestApi?.composerDragKind).toBe("attachment");

    act(() =>
      latestApi?.handleDragOverComposer({
        dataTransfer: {
          dropEffect: "none",
          items: [],
          types: ["application/x-zcode-workspace-file"],
        },
        preventDefault,
      } as unknown as DragEvent<HTMLElement>),
    );
    expect(latestApi?.composerDragKind).toBe("workspace");

    act(() =>
      latestApi?.handleDropComposer({
        dataTransfer: {
          files: [],
          types: ["application/x-zcode-workspace-file"],
        },
        preventDefault,
      } as unknown as DragEvent<HTMLElement>),
    );
    expect(latestApi?.composerDragKind).toBeNull();
    act(() => root.unmount());
  });

  it("本地桌面 localPath 零拷贝直接 ready，不显示虚假完成进度", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const { root } = renderProbe({
      attachmentSessionId: "session-1",
      localDesktop: true,
      scopeId: "task-a",
    });

    await addPaths(["/tmp/local.png"]);

    expect(transfer.stage).not.toHaveBeenCalled();
    expect(latestApi?.attachments[0]).toMatchObject({
      attachmentRef: {
        fileName: "local.png",
        ref: "/tmp/local.png",
      },
      localZeroCopy: true,
      referenceOwnership: "composer",
      showComplete: false,
      uploadProgress: 100,
      uploadStatus: "ready",
    });
    act(() => root.unmount());
  });

  it("session 尚未预热时停在 waitingSession，session ready 后再进入上传", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockResolvedValue(resultFor("waited"));
    const { rerender, root } = renderProbe({
      attachmentSessionId: null,
      scopeId: "task-a",
    });

    await addPaths(["/tmp/a.png"]);
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("waitingSession");
    expect(transfer.stage).not.toHaveBeenCalled();

    rerender({ attachmentSessionId: "session-1", scopeId: "task-a" });
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    act(() => root.unmount());
  });

  it("远端 identity 已知但 remoteSessionId 暂缺时等待，注入后再物化", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockResolvedValue(resultFor("remote-session-ready"));
    const { rerender, root } = renderProbe({
      attachmentSessionId: "session-1",
      remoteSessionId: null,
      scopeId: "remote-session-wait",
    });

    await addPaths(["C:\\Users\\tester\\attachment.png"]);
    expect(latestApi?.attachments[0]).toMatchObject({
      localZeroCopy: false,
      uploadStatus: "waitingSession",
    });
    expect(transfer.stage).not.toHaveBeenCalled();

    rerender({
      attachmentSessionId: "session-1",
      remoteSessionId: "remote-session-1",
      scopeId: "remote-session-wait",
    });
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(latestApi?.attachments[0]?.attachmentRef?.ref).toBe("/remote/remote-session-ready");
    act(() => root.unmount());
  });

  it("非规范远端 identity 在 remoteSessionId 注入前也保持等待而不走本地零复制", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockResolvedValue(resultFor("noncanonical-remote-identity"));
    const workspaceIdentity = "remote:wsl:Debian:user:relative/path";
    const { rerender, root } = renderProbe({
      attachmentSessionId: "session-1",
      remoteSessionId: null,
      scopeId: "noncanonical-remote-session-wait",
      workspaceIdentity,
    });

    await addPaths(["C:\\Users\\tester\\attachment.png"]);
    expect(latestApi?.attachments[0]).toMatchObject({
      localZeroCopy: false,
      uploadStatus: "waitingSession",
    });
    expect(transfer.stage).not.toHaveBeenCalled();

    rerender({
      attachmentSessionId: "session-1",
      remoteSessionId: "remote-session-1",
      scopeId: "noncanonical-remote-session-wait",
      workspaceIdentity,
    });
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(latestApi?.attachments[0]?.attachmentRef?.ref).toBe(
      "/remote/noncanonical-remote-identity",
    );
    act(() => root.unmount());
  });

  it("远端 stage 未物化路径时永久失败并保持发送门禁", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async (params) => ({
      bytes: 100,
      operationId: params.operationId,
      ref: "C:\\Users\\tester\\attachment.png",
      staged: false,
    }));
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "fail-closed" });

    await addPaths(["C:\\Users\\tester\\attachment.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("failed"));

    expect(transfer.stage).toHaveBeenCalledTimes(1);
    expect(latestApi?.attachments[0]).toMatchObject({
      autoRetryCount: 0,
      uploadError: "chat.attachments.upload.remoteMaterializationRequired",
      uploadErrorKind: "permanent",
      uploadProgress: 0,
    });
    await expect(latestApi?.prepareForSend()).resolves.toBeNull();
    act(() => root.unmount());
  });

  it("最多并发 2 路，并在一个完成后启动队列中的第三个", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const pending = new Map<string, Deferred<ReturnType<typeof resultFor>>>();
    transfer.stage.mockImplementation((params) => {
      const request = deferred<ReturnType<typeof resultFor>>();
      pending.set(params.operationId, request);
      return request.promise;
    });
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });

    await addPaths(["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]);
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(2));
    expect(latestApi?.attachments.map((item) => item.uploadStatus)).toEqual([
      "uploading",
      "uploading",
      "queued",
    ]);

    const firstOperation = transfer.stage.mock.calls[0]?.[0].operationId ?? "";
    await act(async () => pending.get(firstOperation)?.resolve(resultFor(firstOperation)));
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(3));
    for (const [operationId, request] of pending) {
      request.resolve(resultFor(operationId));
    }
    await vi.waitFor(() =>
      expect(latestApi?.attachments.every((item) => item.uploadStatus === "ready")).toBe(true),
    );
    act(() => root.unmount());
  });

  it("任务切换不取消后台上传，切回后恢复 ready 状态", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const pending = deferred<ReturnType<typeof resultFor>>();
    transfer.stage.mockImplementation(() => pending.promise);
    const runtime = { listener: null as (() => void) | null };
    const onRuntimeRestart = (listener: () => void) => {
      runtime.listener = listener;
      return () => {
        runtime.listener = null;
      };
    };
    const { rerender, root } = renderProbe({
      attachmentSessionId: "session-1",
      onRuntimeRestart,
      scopeId: "task-a",
    });
    await addPaths(["/tmp/a.png"]);
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(1));
    const operationId = transfer.stage.mock.calls[0]?.[0].operationId ?? "";

    rerender({ attachmentSessionId: "session-2", onRuntimeRestart, scopeId: "task-b" });
    expect(latestApi?.attachments).toEqual([]);
    await act(async () => pending.resolve(resultFor(operationId)));
    rerender({ attachmentSessionId: "session-1", onRuntimeRestart, scopeId: "task-a" });

    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(transfer.service.cancel).not.toHaveBeenCalled();
    await expect(latestApi?.prepareForSend()).resolves.toHaveLength(1);
    expect(transfer.service.adopt).not.toHaveBeenCalled();
    await latestApi?.adoptSentAttachments(latestApi.attachments.map((item) => item.id));
    expect(transfer.service.adopt).toHaveBeenCalledWith(operationId);
    act(() => root.unmount());
  });

  it("发送接纳只移交和清理本次附件，等待期间新增的附件仍属于草稿", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async ({ operationId }) => resultFor(operationId));
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });
    await addPaths(["/tmp/sent.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    const submitted = latestApi!.attachments.map((item) => item.id);
    const submittedOperation = latestApi!.attachments[0]!.operationId;
    mocks.platform.selectFiles.mockResolvedValueOnce(["/tmp/next.png"]);
    act(() => latestApi!.openAttachmentPicker());
    await vi.waitFor(() => expect(latestApi!.attachments).toHaveLength(2));
    await vi.waitFor(() => expect(latestApi!.attachments[1]!.uploadStatus).toBe("ready"));
    await act(async () => {
      await latestApi!.adoptSentAttachments(submitted);
      latestApi!.clearAttachments(submitted);
    });
    expect(transfer.service.adopt).toHaveBeenCalledTimes(1);
    expect(transfer.service.adopt).toHaveBeenCalledWith(submittedOperation);
    expect(transfer.service.cleanup).not.toHaveBeenCalled();
    expect(latestApi!.attachments).toHaveLength(1);
    expect(latestApi!.attachments[0]).toMatchObject({ filename: "next.png", adopted: false });
    act(() => root.unmount());
  });

  it("composer 局部卸载后上传继续，重新挂载从 renderer store 恢复", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const pending = deferred<ReturnType<typeof resultFor>>();
    transfer.stage.mockImplementation(() => pending.promise);
    const firstMount = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });
    await addPaths(["/tmp/a.png"]);
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(1));
    const operationId = transfer.stage.mock.calls[0]?.[0].operationId ?? "";

    act(() => firstMount.root.unmount());
    expect(transfer.service.cancel).not.toHaveBeenCalled();
    await act(async () => pending.resolve(resultFor(operationId)));
    await vi.waitFor(() =>
      expect(
        Object.values(useComposerAttachmentUploadStore.getState().scopes)[0]?.[0]?.uploadStatus,
      ).toBe("ready"),
    );

    const secondMount = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready");
    act(() => secondMount.root.unmount());
  });

  it("进度只增不减，committing 最高 99%，完成后 300ms 淡出", async () => {
    vi.useFakeTimers();
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const pending = deferred<ReturnType<typeof resultFor>>();
    transfer.stage.mockImplementation(() => pending.promise);
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });
    mocks.platform.selectFiles.mockResolvedValueOnce(["/tmp/a.png"]);
    act(() => latestApi?.openAttachmentPicker());
    await act(async () => Promise.resolve());
    const operationId = latestApi?.attachments[0]?.operationId ?? "";

    act(() => {
      transfer.fire(operationId, { phase: "uploading", uploadedBytes: 50, totalBytes: 100 });
      transfer.fire(operationId, { phase: "uploading", uploadedBytes: 20, totalBytes: 100 });
      transfer.fire(operationId, { phase: "committing", uploadedBytes: 100, totalBytes: 100 });
    });
    expect(latestApi?.attachments[0]).toMatchObject({
      uploadProgress: 99,
      uploadStatus: "committing",
    });

    await act(async () => pending.resolve(resultFor(operationId)));
    expect(latestApi?.attachments[0]).toMatchObject({
      showComplete: true,
      uploadProgress: 100,
      uploadStatus: "ready",
    });
    await act(async () => vi.advanceTimersByTimeAsync(COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS));
    expect(latestApi?.attachments[0]?.showComplete).toBe(false);
    act(() => root.unmount());
  });

  it("瞬时失败仅自动重试一次，手动重试开启新的预算", async () => {
    vi.useFakeTimers();
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resultFor("manual"));
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });
    mocks.platform.selectFiles.mockResolvedValueOnce(["/tmp/a.png"]);
    act(() => latestApi?.openAttachmentPicker());
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await act(async () => Promise.resolve());

    expect(transfer.stage).toHaveBeenCalledTimes(2);
    expect(latestApi?.attachments[0]).toMatchObject({
      autoRetryCount: 1,
      uploadErrorKind: "transient",
      uploadStatus: "failed",
    });
    act(() => latestApi?.retryAttachment(latestApi.attachments[0]?.id ?? ""));
    await act(async () => Promise.resolve());

    expect(transfer.stage).toHaveBeenCalledTimes(3);
    expect(latestApi?.attachments[0]).toMatchObject({
      autoRetryCount: 0,
      uploadStatus: "ready",
    });
    act(() => root.unmount());
  });

  it("不可重试错误直接进入 permanent failed，不消耗自动重试预算", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockRejectedValue(new Error("EACCES permission denied"));
    const { root } = renderProbe({ attachmentSessionId: "session-1", scopeId: "task-a" });

    await addPaths(["/tmp/secret.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("failed"));

    expect(transfer.stage).toHaveBeenCalledTimes(1);
    expect(latestApi?.attachments[0]).toMatchObject({
      autoRetryCount: 0,
      uploadErrorKind: "permanent",
    });
    act(() => root.unmount());
  });

  it("删除立即取消上传；runtime restart 使 ready 远端 ref 按剩余预算重传", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    const first = deferred<ReturnType<typeof resultFor>>();
    transfer.stage
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(resultFor("ready-before-restart"))
      .mockResolvedValueOnce(resultFor("restarted"));
    let restart: (() => void) | null = null;
    const onRuntimeRestart = (listener: () => void) => {
      restart = listener;
      return () => {
        restart = null;
      };
    };
    const { root } = renderProbe({
      attachmentSessionId: "session-1",
      onRuntimeRestart,
      scopeId: "task-a",
    });
    await addPaths(["/tmp/a.png"]);
    const firstItem = latestApi?.attachments[0];
    act(() => latestApi?.removeAttachment(firstItem?.id ?? ""));
    expect(transfer.service.cancel).toHaveBeenCalledWith(firstItem?.operationId);
    await act(async () => first.resolve(resultFor(firstItem?.operationId ?? "")));

    await addPaths(["/tmp/b.png"]);
    const readyOperation = transfer.stage.mock.calls[1]?.[0].operationId ?? "";
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    act(() => restart?.());
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(3));
    expect(transfer.service.cleanup).toHaveBeenCalledWith(readyOperation);
    expect(latestApi?.attachments[0]).toMatchObject({
      // 换代重传不再消耗上传失败重试配额，改记在 runtimeRebuildRetryCount 上。
      autoRetryCount: 0,
      runtimeRebuildRetryCount: 1,
      uploadStatus: "ready",
    });
    act(() => root.unmount());
  });

  it("queue 撤回的 session-owned refs 保序 ready，重发/restart/删除均不重复处理", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    let restart: (() => void) | null = null;
    const onRuntimeRestart = (listener: () => void) => {
      restart = listener;
      return () => {
        restart = null;
      };
    };
    const { root } = renderProbe({
      attachmentSessionId: "session-1",
      onRuntimeRestart,
      scopeId: "task-a",
    });
    const refs = [
      {
        ref: "session-ref-b",
        fileName: "b.png",
        mime: "image/png",
        bytes: 2,
        previewRef: "preview-b",
      },
      {
        ref: "session-ref-a",
        fileName: "a.txt",
        mime: "text/plain",
        bytes: 1,
        sourceKind: "topic-history" as const,
        messageCount: 2,
      },
    ];

    act(() => expect(latestApi?.restoreSessionOwnedAttachments(refs)).toBe(true));
    expect(latestApi?.attachments.map((item) => item.filename)).toEqual(["b.png", "a.txt"]);
    expect(latestApi?.attachments[1]).toMatchObject({
      sourceKind: "topic-history",
      messageCount: 2,
    });
    expect(latestApi?.attachments).toEqual(
      refs.map((ref) =>
        expect.objectContaining({
          adopted: true,
          attachmentRef: ref,
          referenceOwnership: "session",
          staged: false,
          uploadProgress: 100,
          uploadStatus: "ready",
        }),
      ),
    );
    await expect(latestApi?.prepareForSend()).resolves.toEqual(refs);
    await latestApi?.adoptSentAttachments(latestApi.attachments.map((item) => item.id));
    expect(transfer.service.adopt).not.toHaveBeenCalled();

    act(() => restart?.());
    expect(transfer.stage).not.toHaveBeenCalled();
    expect(transfer.service.cleanup).not.toHaveBeenCalled();
    expect(latestApi?.attachments.every((item) => item.uploadStatus === "ready")).toBe(true);

    act(() => latestApi?.removeAttachment(latestApi.attachments[0]?.id ?? ""));
    expect(transfer.service.cancel).not.toHaveBeenCalled();
    expect(transfer.service.cleanup).not.toHaveBeenCalled();
    expect(latestApi?.attachments.map((item) => item.filename)).toEqual(["a.txt"]);
    act(() => root.unmount());
  });

  it("换代后清空旧 ref；会话尚未重建时不入队，新会话到达才重传", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage
      .mockResolvedValueOnce(resultFor("before-rebuild"))
      .mockResolvedValueOnce(resultFor("after-rebuild"));
    let restart: (() => void) | null = null;
    const onRuntimeRestart = (listener: () => void) => {
      restart = listener;
      return () => {
        restart = null;
      };
    };
    const probe = renderProbe({
      attachmentSessionId: "draft-1",
      onRuntimeRestart,
      scopeId: "rebuild-requeue",
    });
    await addPaths(["/tmp/a.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(transfer.stage).toHaveBeenCalledTimes(1);

    // 预热会话被 retire：effectiveSessionId 回落 null，此时换代不能拿任何 id 去入队。
    probe.rerender({ attachmentSessionId: null, onRuntimeRestart, scopeId: "rebuild-requeue" });
    act(() => restart?.());

    expect(latestApi?.attachments[0]?.uploadStatus).toBe("waitingSession");
    expect(latestApi?.attachments[0]?.attachmentRef).toBeUndefined();
    expect(transfer.stage).toHaveBeenCalledTimes(1);

    // 新预热会话到达 → 唤醒重传。
    probe.rerender({
      attachmentSessionId: "draft-2",
      onRuntimeRestart,
      scopeId: "rebuild-requeue",
    });
    await vi.waitFor(() => expect(transfer.stage).toHaveBeenCalledTimes(2));
    probe.root.unmount();
  });

  it("换代重传独立计数：连传 5 次仍重传，第 6 次判失败，且不消耗 autoRetryCount", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async () =>
      resultFor(`rebuild-${transfer.stage.mock.calls.length}`),
    );
    let restart: (() => void) | null = null;
    const onRuntimeRestart = (listener: () => void) => {
      restart = listener;
      return () => {
        restart = null;
      };
    };
    const { root } = renderProbe({
      attachmentSessionId: "draft-1",
      onRuntimeRestart,
      scopeId: "rebuild-quota",
    });
    await addPaths(["/tmp/c.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    for (let round = 1; round <= 5; round += 1) {
      act(() => restart?.());
      await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
      expect(latestApi?.attachments[0]).toMatchObject({
        autoRetryCount: 0,
        runtimeRebuildRetryCount: round,
      });
    }

    // 第 6 次换代超出兜底上限 → 判失败，交给用户手动重试。
    act(() => restart?.());
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("failed");
    act(() => root.unmount());
  });

  // Bug 回归：CUA Helper 就绪走 workspace-dispose，而 onRuntimeRestart 只在新 agent 进程
  // spawn 时才发。agent 是懒启动——那一刻没人拉起它，换代通知永不到达，附件卡在
  // waitingSession 直到用户手动点一次发送才被踹活（生产实测间隔 2.3s/6.0s/26.3s，
  // 全等于用户点击时刻）。dispose 当场唯一可观测的信号是 lifecycle unavailable。
  it("lifecycle unavailable → 静默作废；新预热会话到达即自动重传，无需任何用户操作", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async () =>
      resultFor(`lifecycle-${transfer.stage.mock.calls.length}`),
    );
    let lifecycle: ((state: "available" | "unavailable") => void) | null = null;
    const onRuntimeLifecycle = (listener: (state: "available" | "unavailable") => void) => {
      lifecycle = listener;
      return () => {
        lifecycle = null;
      };
    };
    const probe = renderProbe({
      attachmentSessionId: "draft-1",
      onRuntimeLifecycle,
      scopeId: "lifecycle-rebuild",
    });
    await addPaths(["/tmp/a.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(transfer.stage).toHaveBeenCalledTimes(1);

    // dispose 当场作废，但不入队：旧 CLI 已死、新的还没起来。
    act(() => lifecycle?.("unavailable"));
    expect(latestApi?.attachments[0]).toMatchObject({
      runtimeRebuildRetryCount: 1,
      uploadStatus: "waitingSession",
    });
    expect(latestApi?.attachments[0]?.attachmentRef).toBeUndefined();
    // 静默：这是一次全自动恢复，chip 只显示「正在等待会话」，不该报错。
    expect(latestApi?.attachments[0]?.uploadError).toBeUndefined();
    expect(latestApi?.attachments[0]?.uploadErrorKind).toBeUndefined();
    expect(transfer.stage).toHaveBeenCalledTimes(1);

    // 预热重建产出新会话 → 自动重传（这正是原来必须手动点发送才发生的事）。
    probe.rerender({
      attachmentSessionId: "draft-2",
      onRuntimeLifecycle,
      scopeId: "lifecycle-rebuild",
    });
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(transfer.stage).toHaveBeenCalledTimes(2);
    probe.root.unmount();
  });

  it("lifecycle available → 会话 id 原地不变也能唤醒重传（正式会话态兜底）", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async () =>
      resultFor(`lifecycle-live-${transfer.stage.mock.calls.length}`),
    );
    let lifecycle: ((state: "available" | "unavailable") => void) | null = null;
    const onRuntimeLifecycle = (listener: (state: "available" | "unavailable") => void) => {
      lifecycle = listener;
      return () => {
        lifecycle = null;
      };
    };
    const { root } = renderProbe({
      attachmentSessionId: "session-1",
      onRuntimeLifecycle,
      scopeId: "lifecycle-live",
    });
    await addPaths(["/tmp/b.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    act(() => lifecycle?.("unavailable"));
    expect(latestApi?.attachments[0]?.uploadStatus).toBe("waitingSession");
    expect(transfer.stage).toHaveBeenCalledTimes(1);

    // 正式会话态 sessionId 不变，唤醒只能靠 available（= 新进程已 spawn，入队才安全）。
    act(() => lifecycle?.("available"));
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));
    expect(transfer.stage).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("两条通道都在时只订阅 lifecycle：restart 不再重复作废、不多烧一次重传配额", async () => {
    const transfer = createTransferService();
    mocks.service = transfer.service;
    transfer.stage.mockImplementation(async () =>
      resultFor(`lifecycle-dedup-${transfer.stage.mock.calls.length}`),
    );
    let lifecycle: ((state: "available" | "unavailable") => void) | null = null;
    let restart: (() => void) | null = null;
    const onRuntimeLifecycle = (listener: (state: "available" | "unavailable") => void) => {
      lifecycle = listener;
      return () => {
        lifecycle = null;
      };
    };
    const onRuntimeRestart = (listener: () => void) => {
      restart = listener;
      return () => {
        restart = null;
      };
    };
    const { root } = renderProbe({
      attachmentSessionId: "draft-1",
      onRuntimeLifecycle,
      onRuntimeRestart,
      scopeId: "lifecycle-dedup",
    });
    await addPaths(["/tmp/c.png"]);
    await vi.waitFor(() => expect(latestApi?.attachments[0]?.uploadStatus).toBe("ready"));

    act(() => lifecycle?.("unavailable"));
    // 真实时序里 restarted 紧跟新进程 spawn 到达；两条都处理会白烧一次重传配额。
    act(() => restart?.());

    expect(latestApi?.attachments[0]?.runtimeRebuildRetryCount).toBe(1);
    expect(restart).toBeNull();
    act(() => root.unmount());
  });
});
