import { createFileSystemError, type FileSystemPort } from "@zcode/contracts";

export class MemoryFileSystem implements FileSystemPort {
  readonly createdDirectories = new Set<string>();
  readonly readRequests: Array<{ maxBytes?: number; path: string }> = [];
  readonly searchFileRequests: Array<{ maxResults?: number; path: string; pattern: string }> = [];

  constructor(
    readonly files: Record<string, string>,
    private readonly fileMtimes: Readonly<Record<string, number>> = {},
  ) {}

  async createDirectory(request: { path: string }) {
    this.createdDirectories.add(request.path);
    return { path: request.path };
  }

  async stat(request: { path: string }) {
    if (this.createdDirectories.has(request.path)) {
      return { kind: "directory" as const, path: request.path, sizeBytes: 0 };
    }
    const content = this.files[request.path];
    if (content === undefined) throw missingFile(request.path);
    return {
      kind: "file" as const,
      path: request.path,
      sizeBytes: Buffer.byteLength(content),
      mtimeMs: this.fileMtimes[request.path],
    };
  }

  async readTextFile(request: { path: string; encoding?: BufferEncoding; maxBytes?: number }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.files[request.path];
    if (content === undefined) throw missingFile(request.path);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const maxBytes = request.maxBytes ?? sizeBytes;
    const truncated = sizeBytes > maxBytes;
    const returned = truncated ? content.slice(0, maxBytes) : content;
    return {
      bytesRead: Buffer.byteLength(returned, "utf8"),
      content: returned,
      encoding: request.encoding ?? "utf8",
      path: request.path,
      sizeBytes,
      truncated,
    };
  }

  async readBinaryFile(request: { path: string; maxBytes?: number }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.files[request.path];
    if (content === undefined) throw missingFile(request.path);
    const buffer = Buffer.from(content, "utf8");
    if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: `File content (${buffer.byteLength}B) exceeds maximum allowed size (${request.maxBytes}B).`,
      });
    }
    return {
      bytesRead: buffer.byteLength,
      content: buffer,
      path: request.path,
      sizeBytes: buffer.byteLength,
    };
  }

  async readTextFileRange(request: {
    path: string;
    encoding?: BufferEncoding;
    offsetLine?: number;
    limitLines?: number;
    maxBytes?: number;
  }) {
    this.readRequests.push({ maxBytes: request.maxBytes, path: request.path });
    const content = this.files[request.path];
    if (content === undefined) throw missingFile(request.path);
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (request.maxBytes !== undefined && sizeBytes > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path: request.path,
        message: `File content (${sizeBytes}B) exceeds maximum allowed size (${request.maxBytes}B). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      });
    }
    const lines = content.length === 0 ? [] : content.split(/\r?\n/);
    const offsetLine = Math.max(0, Math.trunc(request.offsetLine ?? 0));
    const limitLines =
      request.limitLines === undefined ? undefined : Math.max(0, Math.trunc(request.limitLines));
    const selected =
      limitLines === undefined
        ? lines.slice(offsetLine)
        : lines.slice(offsetLine, offsetLine + limitLines);
    return {
      bytesRead: sizeBytes,
      content: selected.join("\n"),
      encoding: request.encoding ?? "utf8",
      lineCount: selected.length,
      path: request.path,
      sizeBytes,
      startLine: offsetLine + 1,
      totalLines: lines.length,
      truncated: false,
    };
  }

  async writeTextFile(request: { content: string; path: string }) {
    this.files[request.path] = request.content;
    return { bytesWritten: Buffer.byteLength(request.content, "utf8"), path: request.path };
  }

  async removeFile(request: { missingOk?: boolean; path: string }) {
    const existed = this.files[request.path] !== undefined;
    if (!existed && request.missingOk !== true) throw missingFile(request.path);
    delete this.files[request.path];
    return { path: request.path, removed: existed };
  }

  async listDirectory(request: { path: string }) {
    const prefix = `${request.path.replace(/\/+$/, "")}/`;
    const seen = new Set<string>();
    const entries = Object.keys(this.files).flatMap((path) => {
      if (!path.startsWith(prefix)) return [];
      const rest = path.slice(prefix.length);
      const [name] = rest.split("/");
      if (!name || seen.has(name)) return [];
      seen.add(name);
      const isDirectory = rest.includes("/");
      return [
        {
          kind: isDirectory ? ("directory" as const) : ("file" as const),
          name,
          path: `${prefix}${name}`,
        },
      ];
    });
    return {
      durationMs: 0,
      entries,
      numEntries: entries.length,
      path: request.path,
    };
  }

  async searchFiles(request: { maxResults?: number; path: string; pattern: string }) {
    this.searchFileRequests.push({
      maxResults: request.maxResults,
      path: request.path,
      pattern: request.pattern,
    });
    const prefix = `${request.path.replace(/\/+$/, "")}/`;
    const files = Object.keys(this.files)
      .filter((path) => path.startsWith(prefix))
      .filter((path) => !path.slice(prefix.length).includes("/"))
      .filter((path) => (request.pattern === "*.md" ? path.endsWith(".md") : true))
      .slice(0, request.maxResults);
    return {
      durationMs: 0,
      files,
      numFiles: files.length,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }

  async searchText(request: {
    outputMode?: "content" | "files_with_matches" | "count";
    path: string;
    pattern: string;
  }) {
    return {
      durationMs: 0,
      entries: [],
      files: [],
      mode: request.outputMode ?? "files_with_matches",
      numMatches: 0,
      path: request.path,
      pattern: request.pattern,
      truncated: false,
    };
  }
}

function missingFile(path: string): Error {
  return createFileSystemError({ code: "not_found", message: `missing: ${path}`, path });
}
