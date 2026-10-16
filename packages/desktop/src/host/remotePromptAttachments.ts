import type { IRemoteBackend, RemoteUploadOptions } from "@zcode/server/remote";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import type { TraceId, ZCodePromptAttachment } from "@zcode/shared";
import { randomUUID } from "node:crypto";

export const REMOTE_PROMPT_ATTACHMENT_ROOT = "~/.zcode/tmp/prompt-attachments";
const REMOTE_PROMPT_ATTACHMENT_RELATIVE_ROOT = ".zcode/tmp/prompt-attachments";

export interface RemotePromptAttachmentMaterializeInput {
  taskId?: string;
  content: string;
  traceId: TraceId | string;
  attachments?: ZCodePromptAttachment[];
}

export interface RemotePromptAttachmentMaterializeResult {
  content: string;
  attachments?: ZCodePromptAttachment[];
  uploadedCount: number;
}

export async function materializeRemotePromptAttachments(
  input: RemotePromptAttachmentMaterializeInput,
  options: {
    backend: Pick<IRemoteBackend, "exec" | "upload">;
    uploadOptions?: RemoteUploadOptions;
  },
): Promise<RemotePromptAttachmentMaterializeResult> {
  const attachments = input.attachments;
  if (!attachments || attachments.length === 0) {
    return { ...input, uploadedCount: 0 };
  }

  const replacements = new Map<string, string>();
  const nextAttachments: ZCodePromptAttachment[] = [];
  let remoteRootPromise: Promise<string> | undefined;
  let uploadedCount = 0;
  let changed = false;

  const getRemoteRoot = () => {
    remoteRootPromise ??= resolveRemotePromptAttachmentRoot(options.backend);
    return remoteRootPromise;
  };

  for (const [index, attachment] of attachments.entries()) {
    const localPath = getAttachmentLocalPath(attachment);
    if (!localPath) {
      nextAttachments.push(attachment);
      continue;
    }

    if (isPathInRoot(localPath, REMOTE_PROMPT_ATTACHMENT_ROOT)) {
      nextAttachments.push(attachment);
      continue;
    }

    const remoteRoot = await getRemoteRoot();
    if (isRemotePromptAttachmentPath(localPath, remoteRoot)) {
      nextAttachments.push(attachment);
      continue;
    }

    const remotePath = buildRemotePromptAttachmentPath({
      filename: attachment.filename,
      index,
      root: remoteRoot,
      traceId: input.traceId,
    });

    try {
      await ensureRemotePromptAttachmentDirectory(options.backend, remotePath, remoteRoot);
      if (options.uploadOptions) {
        await options.backend.upload(localPath, remotePath, options.uploadOptions);
      } else {
        await options.backend.upload(localPath, remotePath);
      }
      await lockDownRemotePromptAttachmentFile(options.backend, remotePath);
    } catch (error) {
      // 上传成功但 chmod/后续提交失败时，远端文件已经存在；若只抛错会一直
      // 占用用户空间并绕过 renderer 删除清理。这里在原始失败边界内尽力回收。
      await cleanupRemotePromptAttachment(options.backend, remotePath).catch(() => {});
      throw new Error(`远端附件上传失败：${attachment.filename}`, {
        cause: error,
      });
    }

    // remote workspace 的 agent 只能读取远端文件系统；host localPath 必须先上传并改写。
    nextAttachments.push({
      ...attachment,
      localPath: remotePath,
    } as ZCodePromptAttachment);
    replacements.set(localPath, remotePath);
    uploadedCount += 1;
    changed = true;
  }

  return {
    content: replaceContentPaths(input.content, replacements),
    attachments: changed ? nextAttachments : attachments,
    uploadedCount,
  };
}

/** eager staging 删除入口；只允许操作附件私有根目录下的路径。 */
export async function cleanupRemotePromptAttachment(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
): Promise<void> {
  const root = await resolveRemotePromptAttachmentRoot(backend);
  if (!isRemotePromptAttachmentPath(remotePath, root)) return;
  const remoteDir = remoteDirname(remotePath);
  await waitForRemoteCommand(
    backend,
    `rm -f ${quotePosixPathArg(remotePath)} && rmdir ${quotePosixPathArg(remoteDir)} 2>/dev/null || true`,
  );
}

/** host 重建后回收无 renderer 持有者的历史暂存附件。 */
export async function cleanupStaleRemotePromptAttachments(
  backend: Pick<IRemoteBackend, "exec">,
  olderThanMinutes = 24 * 60,
): Promise<void> {
  const root = await resolveRemotePromptAttachmentRoot(backend);
  await waitForRemoteCommand(
    backend,
    `if [ -d ${quotePosixPathArg(root)} ]; then find ${quotePosixPathArg(root)} -type f -mmin +${Math.max(1, Math.floor(olderThanMinutes))} -delete; find ${quotePosixPathArg(root)} -mindepth 1 -depth -type d -empty -delete; fi`,
  );
}

export function buildRemotePromptAttachmentPath(params: {
  filename: string;
  index: number;
  nonce?: string;
  root?: string;
  traceId: TraceId | string;
}): string {
  const traceSegment = sanitizePathSegment(String(params.traceId)).slice(0, 80) || "trace";
  const nonceSegment = sanitizePathSegment(params.nonce ?? createAttachmentNonce()).slice(0, 64);
  const filename = sanitizePathSegment(basenameFromPathLike(params.filename)) || "attachment";
  const indexSegment = String(params.index + 1).padStart(2, "0");
  const root = params.root ?? REMOTE_PROMPT_ATTACHMENT_ROOT;
  return `${root}/${traceSegment}/${nonceSegment}/${indexSegment}-${filename.slice(0, 160)}`;
}

async function ensureRemotePromptAttachmentDirectory(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
  root: string,
): Promise<void> {
  const remoteDir = remoteDirname(remotePath);
  const privateDirs = collectRemotePromptAttachmentPrivateDirs(remoteDir, root);
  // prompt 附件可能包含剪贴板、图片和本地文件内容，不能落在公共 /tmp；远端物化前先创建用户私有目录并收紧权限。
  const command = [
    `mkdir -p ${quotePosixPathArg(remoteDir)}`,
    `command chmod 700 ${privateDirs.map((dir) => quotePosixPathArg(dir)).join(" ")}`,
  ].join(" && ");
  await waitForRemoteCommand(backend, command);
}

async function lockDownRemotePromptAttachmentFile(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
): Promise<void> {
  await waitForRemoteCommand(backend, `command chmod 600 ${quotePosixPathArg(remotePath)}`);
}

async function resolveRemotePromptAttachmentRoot(
  backend: Pick<IRemoteBackend, "exec">,
): Promise<string> {
  const homeDir = await readRemoteCommandStdout(backend, 'printf %s "$HOME"');
  const normalizedHome = homeDir.trim().replace(/\/+$/u, "");
  if (!normalizedHome.startsWith("/")) {
    throw new Error("remote HOME is not an absolute path");
  }
  return `${normalizedHome}/${REMOTE_PROMPT_ATTACHMENT_RELATIVE_ROOT}`;
}

async function readRemoteCommandStdout(
  backend: Pick<IRemoteBackend, "exec">,
  command: string,
): Promise<string> {
  const stream = await backend.exec(command);
  let stdoutText = "";
  let stderrText = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    stdoutText += chunk.toString();
  });
  stream.stderr.on("data", (chunk: Buffer | string) => {
    stderrText += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `remote command failed with exit code ${code}: ${command}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    });
  });
  return stdoutText;
}

async function waitForRemoteCommand(
  backend: Pick<IRemoteBackend, "exec">,
  command: string,
): Promise<void> {
  const stream = await backend.exec(command);
  await new Promise<void>((resolve, reject) => {
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`remote command failed with exit code ${code}: ${command}`));
    });
  });
}

function getAttachmentLocalPath(attachment: ZCodePromptAttachment): string | undefined {
  const localPath = attachment.localPath?.trim();
  return localPath ? attachment.localPath : undefined;
}

function isRemotePromptAttachmentPath(path: string, remoteRoot: string): boolean {
  return isPathInRoot(path, REMOTE_PROMPT_ATTACHMENT_ROOT) || isPathInRoot(path, remoteRoot);
}

function isPathInRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function remoteDirname(remotePath: string): string {
  const slashIndex = remotePath.lastIndexOf("/");
  return slashIndex > 0 ? remotePath.slice(0, slashIndex) : REMOTE_PROMPT_ATTACHMENT_ROOT;
}

function collectRemotePromptAttachmentPrivateDirs(remoteDir: string, root: string): string[] {
  const relativeDir = remoteDir.startsWith(`${root}/`) ? remoteDir.slice(root.length + 1) : "";
  const segments = relativeDir.split("/").filter(Boolean);
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

function createAttachmentNonce(): string {
  return randomUUID();
}

function replaceContentPaths(content: string, replacements: Map<string, string>): string {
  let next = content;
  const orderedReplacements = [...replacements.entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [from, to] of orderedReplacements) {
    next = next.split(from).join(to);
  }
  return next;
}

function basenameFromPathLike(pathLike: string): string {
  const segments = pathLike.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? pathLike;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replaceAll("\0", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return sanitized || "attachment";
}

export function createRemotePromptAttachmentTaskService<T extends object>(
  service: T,
  options: {
    materializePromptAttachments: (
      params: RemotePromptAttachmentMaterializeInput & { taskId: string },
    ) => Promise<Pick<RemotePromptAttachmentMaterializeResult, "content" | "attachments">>;
  },
): T {
  return createRemotePromptAttachmentServiceProxy(service, {
    methods: new Set(["sendPrompt", "enqueueTaskCommand"]),
    materializePromptAttachments: options.materializePromptAttachments,
    readTaskId: (params) => stringValue((params as { taskId?: unknown }).taskId),
    readTraceId: (params) => stringValue((params as { traceId?: unknown }).traceId),
  });
}

export function createRemotePromptAttachmentSessionService<T extends object>(
  service: T,
  options: {
    materializePromptAttachments: (
      params: RemotePromptAttachmentMaterializeInput & { taskId: string },
    ) => Promise<Pick<RemotePromptAttachmentMaterializeResult, "content" | "attachments">>;
  },
): T {
  return createRemotePromptAttachmentServiceProxy(service, {
    methods: new Set(["sendPrompt"]),
    materializePromptAttachments: options.materializePromptAttachments,
    readTaskId: (params) => stringValue((params as { sessionId?: unknown }).sessionId),
    readTraceId: (params) =>
      stringValue((params as { inputId?: unknown }).inputId) ??
      stringValue((params as { sessionId?: unknown }).sessionId),
  });
}

function createRemotePromptAttachmentServiceProxy<T extends object>(
  service: T,
  options: {
    methods: Set<string>;
    materializePromptAttachments: (
      params: RemotePromptAttachmentMaterializeInput & { taskId: string },
    ) => Promise<Pick<RemotePromptAttachmentMaterializeResult, "content" | "attachments">>;
    readTaskId: (params: object) => string | undefined;
    readTraceId: (params: object) => string | undefined;
  },
): T {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property !== "string" ||
        !options.methods.has(property) ||
        typeof value !== "function"
      ) {
        return value;
      }

      return async (...args: unknown[]) => {
        const params = args[0];
        if (typeof params !== "object" || params === null) {
          return value.apply(target, args);
        }
        const content = stringValue((params as { content?: unknown }).content);
        const taskId = options.readTaskId(params);
        const traceId = options.readTraceId(params);
        if (content === undefined || !taskId || !traceId) {
          return value.apply(target, args);
        }
        const prepared = await options.materializePromptAttachments({
          taskId,
          traceId,
          content,
          attachments: Array.isArray((params as { attachments?: unknown }).attachments)
            ? (params as { attachments?: ZCodePromptAttachment[] }).attachments
            : undefined,
        });
        const nextParams: Record<string, unknown> = {
          ...params,
          content: prepared.content,
        };
        if ("attachments" in params || prepared.attachments !== undefined) {
          nextParams.attachments = prepared.attachments;
        }
        return value.call(target, nextParams);
      };
    },
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
