export type ParsedPatch =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] };

export interface PatchChunk {
  oldLines: string[];
  newLines: string[];
  changeContext?: string;
  endOfFile?: boolean;
}

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_HEADER = "*** Add File:";
const DELETE_HEADER = "*** Delete File:";
const UPDATE_HEADER = "*** Update File:";
const MOVE_HEADER = "*** Move to:";
const END_OF_FILE_MARKER = "*** End of File";

export function parseStructuredPatch(patchText: string): ParsedPatch[] {
  const normalized = stripHeredoc(patchText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.trim().split("\n");
  const beginIndex = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
  const endIndex = lines.findIndex((line) => line.trim() === END_MARKER);

  if (beginIndex === -1 || endIndex === -1 || beginIndex >= endIndex) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  const sections: ParsedPatch[] = [];
  let index = beginIndex + 1;
  while (index < endIndex) {
    const line = lines[index] ?? "";
    if (line.startsWith(ADD_HEADER)) {
      const path = readHeaderPath(line, ADD_HEADER);
      const parsed = parseAddFile(lines, index + 1, endIndex);
      sections.push({ type: "add", path, contents: parsed.contents });
      index = parsed.nextIndex;
      continue;
    }
    if (line.startsWith(DELETE_HEADER)) {
      sections.push({ type: "delete", path: readHeaderPath(line, DELETE_HEADER) });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_HEADER)) {
      const path = readHeaderPath(line, UPDATE_HEADER);
      let movePath: string | undefined;
      index += 1;
      if (index < endIndex && (lines[index] ?? "").startsWith(MOVE_HEADER)) {
        movePath = readHeaderPath(lines[index] ?? "", MOVE_HEADER);
        index += 1;
      }
      const parsed = parseUpdateChunks(lines, index, endIndex);
      sections.push({ type: "update", path, movePath, chunks: parsed.chunks });
      index = parsed.nextIndex;
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    throw new Error(`Invalid patch section header: ${line}`);
  }

  return sections;
}

function parseAddFile(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { contents: string; nextIndex: number } {
  const contents: string[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const line = lines[index] ?? "";
    if (!line.startsWith("+")) {
      throw new Error(`Invalid add file line: ${line}`);
    }
    contents.push(line.slice(1));
    index += 1;
  }
  return { contents: `${contents.join("\n")}\n`, nextIndex: index };
}

function parseUpdateChunks(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { chunks: PatchChunk[]; nextIndex: number } {
  const chunks: PatchChunk[] = [];
  let index = startIndex;
  while (index < endIndex && !isSectionHeader(lines[index] ?? "")) {
    const header = lines[index] ?? "";
    if (!header.startsWith("@@")) {
      if (header.trim().length === 0) {
        index += 1;
        continue;
      }
      throw new Error(`Invalid update hunk header: ${header}`);
    }

    const changeContext = header.slice(2).trim() || undefined;
    index += 1;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let endOfFile = false;

    while (index < endIndex && !startsNextHunkOrSection(lines[index] ?? "")) {
      const line = lines[index] ?? "";
      if (line === END_OF_FILE_MARKER) {
        endOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else {
        throw new Error(`Invalid update hunk line: ${line}`);
      }
      index += 1;
    }

    chunks.push({ oldLines, newLines, changeContext, endOfFile });
  }
  return { chunks, nextIndex: index };
}

function startsNextHunkOrSection(line: string): boolean {
  return line.startsWith("@@") || isSectionHeader(line);
}

function isSectionHeader(line: string): boolean {
  return (
    line.startsWith(ADD_HEADER) ||
    line.startsWith(DELETE_HEADER) ||
    line.startsWith(UPDATE_HEADER) ||
    line.trim() === END_MARKER
  );
}

function readHeaderPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (value.length === 0) {
    throw new Error(`Missing path for ${prefix}`);
  }
  return value;
}

function stripHeredoc(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^(?:cat\s+)?<<['"]?([A-Za-z0-9_]+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
  return match ? (match[2] ?? "") : input;
}
