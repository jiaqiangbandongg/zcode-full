import { FILE_CHUNK_BYTES, type DocKind } from "#office/contract.ts";
import { getHost } from "#ui/host.ts";

/** A failed server tool call; `code` is the server's OfficeErrorCode when it sent one. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CallError";
  }
}

export async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const host = getHost();
  await host.ready();
  const result = await host.app.callServerTool({ name, arguments: args });
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const error = structured?.error as { message?: string; code?: string } | undefined;
  if (result.isError || error) {
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    throw new CallError(error?.message ?? text ?? `${name} failed`, error?.code);
  }
  return structured as T;
}

export interface WorkspaceFile {
  path: string;
  kind: DocKind;
  bytes: number;
  mtimeMs?: number;
}

let listing: Promise<WorkspaceFile[]> | undefined;
/** Workspace documents, newest first. Cached for the page's lifetime unless `fresh`. */
export function listDocuments(fresh = false): Promise<WorkspaceFile[]> {
  if (fresh || !listing)
    listing = call<{ documents: WorkspaceFile[] }>("list_documents").then(
      (result) => [...result.documents].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)),
      (error) => {
        listing = undefined;
        throw error;
      },
    );
  return listing;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
};

/** 通过系统选择器授权的 File 分块导入，桌面与 Web 都不需要暴露本机绝对路径。 */
export async function importSelectedFile(file: File): Promise<string> {
  const { id } = await call<{ id: string }>("begin_file_import", {
    name: file.name,
    size: file.size,
  });
  try {
    for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file.slice(offset, offset + FILE_CHUNK_BYTES));
      });
      await call("write_file_import", { id, offset, data });
    }
    const result = await call<{ path: string }>("finish_file_import", { id });
    return result.path;
  } catch (error) {
    await call("cancel_file_import", { id }).catch(() => undefined);
    throw error;
  }
}
