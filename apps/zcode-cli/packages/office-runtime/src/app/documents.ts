import { randomUUID } from "node:crypto";
import {
  FILE_CHUNK_BYTES,
  OfficeError,
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type Selection,
  type ShowTarget,
  type ViewerSnapshot,
  type ViewState,
} from "#office/contract.ts";
import { formatLocator, parseLocator, splitAnchor } from "#office/domain/anchor.ts";
import type { Hit, ParsedDocument, ReadPage } from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import type { LoadedFile, WorkspaceFiles } from "#office/adapters/files.ts";

export type Parser = (file: LoadedFile) => Promise<ParsedDocument>;

interface Entry {
  file: LoadedFile;
  fingerprint: string;
  parsed: Promise<ParsedDocument>;
}

const MAX_CACHED = 6;
const MAX_HANDLES = 4;

/**
 * Owns everything the viewer knows: parsed documents (cached by path and revision), file handles
 * the panel reads bytes through, the document the viewer shows and the user's last reported view.
 * Server tools and the panel only go through this owner.
 */
export function createDocumentOwner({ files, parse }: { files: WorkspaceFiles; parse: Parser }) {
  const cache = new Map<string, Entry>();
  const handles = new Map<string, { bytes: Uint8Array; path: string; revision: string }>();
  let current: DocumentInfo | null = null;
  const emptyView = (): ViewState => ({
    path: null,
    kind: null,
    at: null,
    selection: null,
    updatedAt: 0,
  });
  const views = new Map<string, ViewState>();
  const reports = new Map<string, number>();
  let sequence = 0;
  let revealSeq = 0;

  async function entry(input: string): Promise<Entry> {
    const { path } = await files.resolve(input);
    const fingerprint = await files.fingerprint(path);
    const cached = cache.get(path);
    if (cached && cached.fingerprint === fingerprint) {
      cache.delete(path);
      cache.set(path, cached);
      return cached;
    }
    const file = await files.load(path);
    const fresh: Entry = { file, fingerprint, parsed: parse(file) };
    fresh.parsed.catch(() => cache.delete(path));
    cache.set(path, fresh);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return fresh;
  }

  async function document(input: string) {
    const item = await entry(input);
    return { file: item.file, doc: await item.parsed };
  }

  const describe = (file: LoadedFile, doc: ParsedDocument): DocumentInfo => ({
    path: file.path,
    kind: file.kind,
    title: doc.title,
    bytes: file.bytes.byteLength,
    revision: file.revision,
    units: doc.units,
    outline: doc.outline,
  });

  /** Validate and normalise a locator for a document; returns its canonical text. */
  function canonical(doc: ParsedDocument, at: string): string {
    return formatLocator(doc.check(parseLocator(doc.kind, at)));
  }

  function snapshot(reveal?: { targets: ShowTarget[]; note?: string }): ViewerSnapshot {
    return {
      document: current,
      ...(reveal ? { reveal: { ...reveal, seq: ++revealSeq } } : {}),
    };
  }

  return {
    async info(path: string): Promise<DocumentInfo> {
      const { file, doc } = await document(path);
      return describe(file, doc);
    },

    /** Make `path` the viewer's document, optionally revealing a location in it. */
    async open(path: string, at?: string | null): Promise<ViewerSnapshot> {
      const { file, doc } = await document(path);
      const target = at ? canonical(doc, at) : null;
      current = describe(file, doc);
      return snapshot(target ? { targets: [{ at: target }] } : undefined);
    },

    /** Point the user at one or more places in one document; opens it if needed. */
    async show(
      targets: { anchor: string; quote?: string }[],
      note?: string,
    ): Promise<ViewerSnapshot> {
      if (!targets.length)
        throw new OfficeError("invalid_anchor", "Give at least one anchor to show.");
      const split = targets.map((target) => ({
        ...splitAnchor(target.anchor),
        quote: target.quote,
      }));
      const path = split[0].path;
      const { path: resolved } = await files.resolve(path);
      for (const item of split) {
        if ((await files.resolve(item.path)).path !== resolved)
          throw new OfficeError(
            "invalid_anchor",
            "All anchors passed to show must be in the same document.",
          );
      }
      const { file, doc } = await document(resolved);
      const resolvedTargets = split.map((item) => ({
        at: item.at ? canonical(doc, item.at) : defaultAt(doc),
        ...(item.quote?.trim() ? { quote: cut(item.quote.trim(), 0, 500) } : {}),
      }));
      current = describe(file, doc);
      return snapshot({
        targets: resolvedTargets,
        ...(note?.trim() ? { note: cut(note.trim(), 0, 500) } : {}),
      });
    },

    async read(
      anchor: string,
      cursor = 0,
    ): Promise<{ info: DocumentInfo; at: string | null; page: ReadPage }> {
      const { path, at } = splitAnchor(anchor);
      const { file, doc } = await document(path);
      const locator = at ? doc.check(parseLocator(doc.kind, at)) : null;
      return {
        info: describe(file, doc),
        at: locator ? formatLocator(locator) : null,
        page: doc.read(locator, cursor),
      };
    },

    async search(
      path: string,
      query: string,
      limit: number,
    ): Promise<{ info: DocumentInfo; hits: Hit[] }> {
      if (!query.trim()) throw new OfficeError("invalid_anchor", "The search query is empty.");
      const { file, doc } = await document(path);
      return { info: describe(file, doc), hits: doc.search(query.trim(), limit) };
    },

    /** Panel only: load bytes for rendering and hand out a token to read them in chunks. */
    async load(
      path: string,
    ): Promise<{ info: DocumentInfo; file: FileHandle; blocks?: DocxBlockKey[] }> {
      const { file, doc } = await document(path);
      const token = randomUUID();
      handles.set(token, { bytes: file.bytes, path: file.path, revision: file.revision });
      while (handles.size > MAX_HANDLES) handles.delete(handles.keys().next().value!);
      return {
        info: describe(file, doc),
        file: {
          token,
          bytes: file.bytes.byteLength,
          chunks: Math.max(1, Math.ceil(file.bytes.byteLength / FILE_CHUNK_BYTES)),
        },
        ...(doc.blocks ? { blocks: doc.blocks } : {}),
      };
    },

    chunk(token: string, index: number): string {
      const handle = handles.get(token);
      if (!handle)
        throw new OfficeError("invalid_token", "This file handle expired; reload the document.");
      const start = index * FILE_CHUNK_BYTES;
      if (!Number.isInteger(index) || index < 0 || (start >= handle.bytes.byteLength && index > 0))
        throw new OfficeError("invalid_token", "Chunk index out of range.");
      return Buffer.from(handle.bytes.subarray(start, start + FILE_CHUNK_BYTES)).toString("base64");
    },

    /** Panel only: record where the user is. The path must be the panel's current document. */
    async report(input: {
      viewId?: string;
      path: string;
      at?: string | null;
      selection?: Selection | null;
    }): Promise<ViewState> {
      const viewId = input.viewId ?? "legacy";
      const ticket = ++sequence;
      reports.set(viewId, ticket);
      const { path, kind } = await files.resolve(input.path);
      const clip = (text: string) => cut(text, 0, 2000);
      const view: ViewState = {
        path,
        kind,
        at: input.at ? cut(input.at, 0, 300) : null,
        selection: input.selection?.at
          ? { at: cut(input.selection.at, 0, 300), text: clip(input.selection.text ?? "") }
          : null,
        updatedAt: Date.now(),
      };
      // 多窗口不能共用最后写者；上报也不应修改 Agent 专用 surface 的当前文档。
      // 旧上报完成时不能覆盖新上报，也不能重新创建已释放的窗口。
      if (reports.get(viewId) !== ticket) return views.get(viewId) ?? emptyView();
      views.set(viewId, view);
      return view;
    },

    views: () => [...views].map(([viewId, view]) => ({ viewId, ...view })),
    releaseView: (viewId: string) => {
      reports.delete(viewId);
      views.delete(viewId);
    },
    view: (viewId?: string) =>
      viewId
        ? (views.get(viewId) ?? emptyView())
        : views.size === 1
          ? views.values().next().value!
          : emptyView(),
    current: () => current,
    snapshot: () => snapshot(),
    close() {
      current = null;
      reports.clear();
      views.clear();
      return snapshot();
    },
    list: (limit?: number) => files.list({ limit }),
  };
}

function defaultAt(doc: ParsedDocument): string {
  switch (doc.kind) {
    case "pdf":
      return "page:1";
    case "pptx":
      return "slide:1";
    case "docx":
      return "p:1";
    case "xlsx":
      return doc.outline[0]?.at ?? "Sheet1";
  }
}

export type DocumentOwner = ReturnType<typeof createDocumentOwner>;
