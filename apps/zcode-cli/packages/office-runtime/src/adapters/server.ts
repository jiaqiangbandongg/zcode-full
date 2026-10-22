import type { createDocumentImporter } from "#office/adapters/files.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASSET_PREFIX,
  FILE_PREFIX,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  HTML_MIME,
  OfficeError,
  PANEL_URI,
  PLUGIN_VERSION,
  SERVER_NAME,
  SURFACE_ID,
  type DocKind,
  type DocumentInfo,
  type ViewerSnapshot,
} from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { truncateBytes } from "#office/domain/model.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import type { DocumentOwner } from "#office/app/documents.ts";
import { isAssetName } from "#office/adapters/assets.ts";
import {
  EXAMPLE_ANCHORS,
  EXAMPLE_LOCATIONS,
  EXTENSIONS_OR,
  FILE_NOUN,
  FILES_NOUN,
  QUOTE_BEST_FOR,
  READ_FORMS,
  TARGET_NOUNS,
  TITLE,
} from "#office/wording.ts";

type Visibility = ("model" | "app")[];

const KIND_NAMES: Record<DocKind, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
  pdf: "PDF",
};
const UNIT_NAMES: Record<DocKind, string> = {
  docx: "blocks",
  xlsx: "sheets",
  pptx: "slides",
  pdf: "pages",
};
const LOCATION_HELP: Record<DocKind, string> = {
  docx: "Locations: p:N (paragraph), p:N-M, t:N (table), t:N/rRcC (table cell).",
  xlsx: "Locations: Sheet, Sheet!A1, Sheet!A1:D20 (quote names with spaces: 'Q3 data'!A1).",
  pptx: "Locations: slide:N, slide:N-M, slide:N/shape:ID.",
  pdf: "Locations: page:N, page:N-M.",
};

/** Model-facing summary of a document: what it is, its outline and how to address it. */
export function describeDocument(info: DocumentInfo, outlineLimit = 60): string {
  const lines = [
    `${info.path}: ${KIND_NAMES[info.kind]}, ${info.units} ${UNIT_NAMES[info.kind]}, ${(info.bytes / 1024).toFixed(0)} KiB, revision ${info.revision}.`,
  ];
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.outline.length) {
    lines.push(info.kind === "xlsx" ? "Sheets:" : info.kind === "pptx" ? "Slides:" : "Outline:");
    for (const item of info.outline.slice(0, outlineLimit))
      lines.push(
        `${"  ".repeat(Math.max(0, item.level - 1))}- ${formatAnchor(info.path, item.at)}  ${item.label}`,
      );
    if (info.outline.length > outlineLimit)
      lines.push(`  … ${info.outline.length - outlineLimit} more`);
  }
  lines.push(LOCATION_HELP[info.kind]);
  return lines.join("\n");
}

function describeSnapshot(snapshot: ViewerSnapshot, verb: string): string {
  if (!snapshot.document) return `The ${TITLE} viewer has no document open.`;
  const parts = [`${verb} ${snapshot.document.path} in the ${TITLE} panel.`];
  if (snapshot.reveal?.targets.length)
    parts.push(
      `Showing: ${snapshot.reveal.targets.map((target) => formatAnchor(snapshot.document!.path, target.at) + (target.quote ? ` ("${target.quote}")` : "")).join(", ")}.`,
    );
  parts.push(
    "",
    describeDocument(snapshot.document),
    "",
    "Use read_document to read content; the user sees the rendered file in the panel.",
  );
  return parts.join("\n");
}

/** Tool results leave the server well formed even if a document's own text is broken. */
const textResult = (text: string, structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: wellFormed(text) }],
  ...(structuredContent ? { structuredContent: wellFormedDeep(structuredContent) } : {}),
});

export function createOfficeServer({
  owner,
  assetRoot,
  importer,
}: {
  owner: DocumentOwner;
  assetRoot: string;
  importer?: ReturnType<typeof createDocumentImporter>;
}) {
  const server = new McpServer({ name: SERVER_NAME, version: PLUGIN_VERSION });

  const register = <Shape extends z.ZodRawShape>(
    name: string,
    config: {
      description: string;
      input: Shape;
      visibility: Visibility;
      /** Route results to the panel (and open it when `openPanel`). */
      panel?: boolean;
      openPanel?: boolean;
      readOnly?: boolean;
    },
    execute: (
      input: z.infer<z.ZodObject<Shape>>,
    ) => Promise<{ text: string; structured?: Record<string, unknown> }>,
  ) => {
    server.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.input,
        annotations: { readOnlyHint: config.readOnly ?? true },
        _meta: {
          ui: config.panel
            ? { resourceUri: PANEL_URI, surface: SURFACE_ID, visibility: config.visibility }
            : { visibility: config.visibility },
          ...(config.openPanel ? { "openai/ui": { preferredModelDisplayMode: "fullscreen" } } : {}),
        },
      },
      (async (input: z.infer<z.ZodObject<Shape>>) => {
        try {
          const { text, structured } = await execute(input);
          return textResult(text, structured);
        } catch (error) {
          const code = error instanceof OfficeError ? error.code : "corrupt_file";
          const message = error instanceof Error ? error.message : String(error);
          if (!(error instanceof OfficeError))
            process.stderr.write(
              `[${SERVER_NAME}] ${name}: ${(error as Error)?.stack ?? message}\n`,
            );
          return {
            isError: true,
            ...textResult(`[${code}] ${message}`, { error: { code, message } }),
          };
        }
      }) as never,
    );
  };

  const anchor = z
    .string()
    .min(1)
    .max(1200)
    .describe(
      `Document anchor: <workspace-relative path>#<location>, e.g. ${EXAMPLE_ANCHORS}. Omit #<location> for the whole document.`,
    );

  register(
    "open_document",
    {
      description: `Open a ${EXTENSIONS_OR} file from the workspace in the ${TITLE} viewer panel, which the user sees. Optionally jump to a location. Returns the document's outline and how to address locations in it. Use this when the user wants to view, review or discuss ${FILE_NOUN}.`,
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        at: z
          .string()
          .max(300)
          .optional()
          .describe(`Optional location to show, e.g. ${EXAMPLE_LOCATIONS}.`),
      },
      visibility: ["model", "app"],
      panel: true,
      openPanel: true,
    },
    async ({ path, at }) => {
      const snapshot = await owner.open(path, at);
      return { text: describeSnapshot(snapshot, "Opened"), structured: { ...snapshot } };
    },
  );

  register(
    "read_document",
    {
      description: `Read the content of a document or of one location in it as text: ${READ_FORMS}. Each block is prefixed with its location so you can cite or show it. Long results are paged: call again with the returned cursor.`,
      input: {
        anchor,
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Cursor from a previous result to continue reading."),
      },
      visibility: ["model"],
    },
    async ({ anchor: target, cursor }) => {
      const { info, at, page } = await owner.read(target, cursor ?? 0);
      const head = `${formatAnchor(info.path, at)} (${KIND_NAMES[info.kind]}, revision ${info.revision})`;
      const tail =
        page.next === null
          ? "[end]"
          : `[more: call read_document with anchor "${formatAnchor(info.path, at)}" and cursor ${page.next}]`;
      return {
        text: `${head}\n\n${page.text || "(no text)"}\n\n${tail}`,
        structured: { path: info.path, at, revision: info.revision, next: page.next },
      };
    },
  );

  register(
    "search_document",
    {
      description:
        "Find text in a document (case-insensitive). Returns matching locations as anchors with a snippet each; pass them to read_document or show_in_viewer.",
      input: {
        path: z.string().min(1).max(1000).describe("Workspace-relative path of the file."),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(100).optional(),
      },
      visibility: ["model"],
    },
    async ({ path, query, limit }) => {
      const { info, hits } = await owner.search(path, query, limit ?? 20);
      const text = hits.length
        ? [
            `${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}" in ${info.path}:`,
            ...hits.map((hit) => `- ${formatAnchor(info.path, hit.at)}  ${hit.snippet}`),
          ].join("\n")
        : `No matches for "${query}" in ${info.path}.`;
      return {
        text,
        structured: {
          path: info.path,
          hits: hits.map((hit) => ({ ...hit, anchor: formatAnchor(info.path, hit.at) })),
        },
      };
    },
  );

  register(
    "show_in_viewer",
    {
      description: `Point the user at specific places in a document: the ${TITLE} panel opens the document, scrolls to the first target and highlights all targets. Use it whenever your answer refers to a particular ${TARGET_NOUNS}. All anchors must be in the same document. \`quote\` highlights that exact text inside the location (best for ${QUOTE_BEST_FOR}).`,
      input: {
        targets: z
          .array(z.object({ anchor, quote: z.string().max(500).optional() }))
          .min(1)
          .max(20),
        note: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional short caption shown in the dedicated Agent panel next to the highlight; manual document windows are not retargeted.",
          ),
      },
      visibility: ["model"],
      panel: true,
      openPanel: true,
    },
    async ({ targets, note }) => {
      const snapshot = await owner.show(targets, note);
      return { text: describeSnapshot(snapshot, "Showing"), structured: { ...snapshot } };
    },
  );

  register(
    "get_view",
    {
      description: `See what the user is looking at in the ${TITLE} panel: the open document, the visible location and the user's current selection with its text. Call this when the user says "this", "here" or "the selected …" about a document.`,
      input: {
        viewId: z
          .string()
          .max(300)
          .optional()
          .describe("Viewer ID from a previous ambiguous get_view result."),
      },
      visibility: ["model"],
    },
    async ({ viewId }) => {
      const views = owner.views();
      if (!viewId && views.length > 1)
        return {
          text:
            "Multiple document viewers have reported views. Ask the user which document they mean, then call get_view with its viewId.\n" +
            views.map((view) => `${view.viewId}: ${view.path}`).join("\n"),
          structured: { ambiguous: true, views },
        };
      if (viewId && !views.some((view) => view.viewId === viewId))
        throw new OfficeError(
          "invalid_token",
          "Unknown viewer. Call get_view without viewId to list viewers.",
        );
      const view = owner.view(viewId);
      const current = view.path ? await owner.info(view.path) : owner.current();
      if (!current && !view.path)
        return {
          text: `The ${TITLE} viewer has no document open. Use open_document to open one.`,
          structured: { view, document: null },
        };
      const path = view.path ?? current!.path;
      const lines = [`Open document: ${path}`];
      if (view.at) lines.push(`Visible location: ${formatAnchor(path, view.at)}`);
      if (view.selection) {
        lines.push(`User selection: ${formatAnchor(path, view.selection.at)}`);
        if (view.selection.text) lines.push(`Selected text: """${view.selection.text}"""`);
        if (view.kind === "xlsx") {
          // The panel shows computed values; add what the file stores (values and formulas).
          const stored = await owner.read(formatAnchor(path, view.selection.at)).catch(() => null);
          if (stored)
            lines.push(
              "Selected cells as stored in the file:",
              truncateBytes(stored.page.text, 4096),
            );
        }
      } else lines.push("No selection.");
      if (view.updatedAt)
        lines.push(
          `(reported ${Math.max(0, Math.round((Date.now() - view.updatedAt) / 1000))} s ago)`,
        );
      if (current) lines.push("", describeDocument(current, 30));
      return { text: lines.join("\n"), structured: { view, document: current } };
    },
  );

  if (importer) {
    register(
      "begin_file_import",
      {
        description:
          "Begin importing a file explicitly selected by the user into a workspace copy.",
        input: {
          name: z.string().min(1).max(255),
          size: z.number().int().min(1).max(MAX_FILE_BYTES),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ name, size }) => ({
        text: "Import started",
        structured: { id: await importer.begin(name, size) },
      }),
    );
    register(
      "write_file_import",
      {
        description: "Append a selected file chunk at its expected offset.",
        input: {
          id: z.string().uuid(),
          offset: z.number().int().min(0),
          data: z
            .string()
            .max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id, offset, data }) => {
        await importer.chunk(id, offset, Buffer.from(data, "base64"));
        return { text: "Chunk imported" };
      },
    );
    register(
      "finish_file_import",
      {
        description: "Finish a selected file import and return the workspace copy path.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => ({
        text: "Import complete",
        structured: { path: await importer.finish(id) },
      }),
    );
    register(
      "cancel_file_import",
      {
        description: "Remove an incomplete file import.",
        input: { id: z.string().uuid() },
        visibility: ["app"],
        readOnly: false,
      },
      async ({ id }) => {
        await importer.cancel(id);
        return { text: "Import cancelled" };
      },
    );
  }

  // Panel-only tools.
  register(
    "list_documents",
    {
      description: `List ${FILES_NOUN} in the workspace for the viewer's file picker.`,
      input: { limit: z.number().int().min(1).max(1000).optional() },
      visibility: ["app"],
    },
    async ({ limit }) => {
      const documents = await owner.list(limit ?? 500);
      return { text: `${documents.length} documents`, structured: { documents } };
    },
  );

  register(
    "load_document",
    {
      description:
        "Load a document for rendering in the viewer: returns its info and a handle to read the bytes.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const loaded = await owner.load(path);
      return { text: describeDocument(loaded.info, 10), structured: { ...loaded } };
    },
  );

  register(
    "check_document",
    {
      description:
        "Return a document's current revision so the viewer can tell when the file changed on disk.",
      input: { path: z.string().min(1).max(1000) },
      visibility: ["app"],
    },
    async ({ path }) => {
      const info = await owner.info(path);
      return { text: info.revision, structured: { path: info.path, revision: info.revision } };
    },
  );

  register(
    "get_viewer",
    {
      description: "Return the document the viewer should show (set by the agent or the user).",
      input: {},
      visibility: ["app"],
    },
    async () => {
      const snapshot = owner.snapshot();
      return { text: describeSnapshot(snapshot, "Viewer has"), structured: { ...snapshot } };
    },
  );

  register(
    "report_view",
    {
      description: "Record the user's current location and selection in the viewer.",
      input: {
        viewId: z.string().min(1).max(300).optional(),
        path: z.string().min(1).max(1000),
        at: z.string().max(300).nullable().optional(),
        selection: z
          .object({ at: z.string().min(1).max(300), text: z.string().max(20000) })
          .nullable()
          .optional(),
      },
      visibility: ["app"],
      readOnly: false,
    },
    async (input) => {
      const view = await owner.report(input);
      return { text: "ok", structured: { view } };
    },
  );

  register(
    "release_view",
    {
      description: "Release a viewer report when its page leaves.",
      input: { viewId: z.string().min(1).max(300) },
      visibility: ["app"],
      readOnly: false,
    },
    async ({ viewId }) => {
      owner.releaseView(viewId);
      return { text: "ok" };
    },
  );

  // Resources: the panel, its assets and file chunks.
  const panelMeta = { "zcode/csp": { wasmUnsafeEval: true } };
  server.registerResource(
    "panel",
    PANEL_URI,
    { mimeType: HTML_MIME, _meta: panelMeta },
    async () => ({
      contents: [
        {
          uri: PANEL_URI,
          mimeType: HTML_MIME,
          text: await readFile(join(assetRoot, "panel.html"), "utf8"),
          _meta: panelMeta,
        },
      ],
    }),
  );

  server.registerResource(
    "assets",
    new ResourceTemplate(`${ASSET_PREFIX}{+name}`, { list: undefined }),
    {},
    async (uri) => {
      const name = decodeURIComponent(uri.href.slice(ASSET_PREFIX.length));
      if (!isAssetName(name))
        throw new OfficeError("invalid_resource", `Unknown UI asset: ${name}`);
      const path = join(assetRoot, name);
      if (/\.(txt|css|json|js)$/.test(name)) {
        const mimeType = name.endsWith(".json")
          ? "application/json"
          : name.endsWith(".css")
            ? "text/css"
            : "text/plain";
        return { contents: [{ uri: uri.href, mimeType, text: await readFile(path, "utf8") }] };
      }
      const bytes = await readFile(path);
      return {
        contents: [
          { uri: uri.href, mimeType: "application/octet-stream", blob: bytes.toString("base64") },
        ],
      };
    },
  );

  server.registerResource(
    "file",
    new ResourceTemplate(`${FILE_PREFIX}{token}/{index}`, { list: undefined }),
    {},
    async (uri, { token, index }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/octet-stream",
          blob: owner.chunk(String(token), Number(index)),
        },
      ],
    }),
  );

  return server;
}
