import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "@zcode/services/node";
import type {
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
} from "@zcode/shared";

/**
 * dwf 产物「作为文件打开」的宿主副本（docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是引擎的 `RunSettlement.artifact`。
 *
 * 为什么是 desktop 自己写一份副本，而不是打开 CLI artifact store 里的那个文件：
 *   - store 跟着 CLI 走，SSH / WSL / Docker 工作区的 CLI 在另一台机器上；
 *   - 外部编辑器写 store 的文件，等于在 journal 记录底下改掉一个已发布的版本；
 *   - 协议得把宿主路径交给 renderer。
 * 字节就是产物 tab 已经读到的那一份，所以这里不需要任何协议或 CLI 改动。
 */

const WORKFLOW_ARTIFACT_DIR = "workflow-artifacts";

/** 与 `artifact.file` 的字节上限同级（dynamic-workflow/src/facade/artifact-caps.ts）。 */
export const WORKFLOW_ARTIFACT_FILE_MAX_BYTES = 20 * 1024 * 1024;

const MAX_SEGMENT_LENGTH = 120;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * 落点：`~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>`（见 {@link identitySegment}）。
 *
 * **只在路径为空时写**：一版的字节永不变，所以已有的副本要么是同一份字节、要么是用户在外部
 * App 里的编辑——两者都该保留，再次打开还是同一个文件。写法是「临时文件 + link」：link 在目标
 * 已存在时以 EEXIST 失败且不覆盖，于是并发两次点击也只会落下一份完整的文件，而一次写到一半
 * 崩掉的进程不会在最终路径上留下半个文件（那样它会因为「已存在」而永远不被重写）。
 */
export async function materializeWorkflowArtifactFile(
  payload: MaterializeWorkflowArtifactFileRequest,
): Promise<MaterializeWorkflowArtifactFileResult> {
  const request = parseRequest(payload);
  const dir = join(
    getZCodeDataRootDir(),
    "tmp",
    WORKFLOW_ARTIFACT_DIR,
    identitySegment(request.runId),
    identitySegment(request.artifactId),
    `v${request.version}`,
  );
  const localPath = join(dir, sanitizeFileName(request.fileName, request.artifactId));

  await mkdir(dir, { recursive: true });
  const temporaryPath = join(dir, `.${randomUUID()}.partial`);
  await writeFile(temporaryPath, request.bytes, { flag: "wx" });
  try {
    await link(temporaryPath, localPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { localPath };
}

/** 请求来自 renderer（IPC 边界），形状与上限在碰磁盘之前再校验一次。 */
function parseRequest(payload: unknown): MaterializeWorkflowArtifactFileRequest {
  const fields = (payload ?? {}) as Partial<
    Record<keyof MaterializeWorkflowArtifactFileRequest, unknown>
  >;
  const { runId, artifactId, version, fileName, bytes } = fields;
  if (
    typeof runId !== "string" ||
    runId.trim().length === 0 ||
    typeof artifactId !== "string" ||
    artifactId.trim().length === 0 ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    typeof fileName !== "string" ||
    !(bytes instanceof Uint8Array)
  ) {
    throw new Error("Workflow artifact file request is invalid");
  }
  if (bytes.byteLength > WORKFLOW_ARTIFACT_FILE_MAX_BYTES) {
    throw new Error(
      `Workflow artifact is too large to open as a file (${bytes.byteLength} bytes, cap ${WORKFLOW_ARTIFACT_FILE_MAX_BYTES})`,
    );
  }
  return { runId, artifactId, version, fileName, bytes };
}

/**
 * run / 产物目录：清洗后的 id 供人读，后缀是**原始** id 的摘要，保证引擎眼里不同的 id 落进不同的目录。
 *
 * 修复原因（MR !2837 评审 CR-02）：目录名曾只是清洗后的 id，而「EEXIST 即同一份」的前提是路径
 * 唯一对应 (run, 产物, 版本)。两种合法 id 会撞：macOS / Windows 的文件系统默认不分大小写
 * （`Report` 与 `report`），清洗去掉开头的点（`.notes` 与 `notes`）。撞上后同名文件以 EEXIST 命中
 * 对方的副本，打开的是另一个产物，连同用户在上面的编辑。runId 由 CLI 铸成 `dwfrun-<uuid>`、本不会撞，
 * 但 IPC 边界只校验它非空，目录的唯一性不该依赖那条约定，所以两段同一规则。
 */
function identitySegment(id: string): string {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
  return `${sanitizeSegment(id)}-${digest}`;
}

/** 目录片段（runId / artifactId）：只留 `[A-Za-z0-9._-]`，去掉开头的点（不留 `.` / `..`、不做隐藏目录）。 */
function sanitizeSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, MAX_SEGMENT_LENGTH);
  return cleaned.length === 0 ? "_" : cleaned;
}

/**
 * 文件名：取最后一段（`/` 与 `\` 都算分隔符），替换各平台的非法字符与控制字符，保留 Unicode
 * 与扩展名——扩展名决定系统用哪个 App 打开。去掉开头的点（不做隐藏文件、不留 `..`）与结尾的
 * 点和空格（Windows 会静默吞掉它们），Windows 保留名前加 `_`。清洗后为空则用产物 id。
 */
function sanitizeFileName(fileName: string, artifactId: string): string {
  const leaf = fileName.split(/[\\/]/u).at(-1) ?? "";
  let cleaned = leaf
    // oxlint-disable-next-line no-control-regex -- 控制字符正是要替换掉的东西。
    .replace(/[<>:"|?*\u0000-\u001f]/gu, "_")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  if (cleaned.length === 0) cleaned = sanitizeSegment(artifactId);
  if (WINDOWS_RESERVED_NAME.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH - extension.length) + extension;
  }
  return cleaned;
}
