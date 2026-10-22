import { OfficeError, type OutlineItem } from "#office/contract.ts";
import type { Locator } from "#office/domain/anchor.ts";
import {
  clampRange,
  markdownTable,
  matchAll,
  normalise,
  paginate,
  snippet,
  type Hit,
  type ParsedDocument,
} from "#office/domain/model.ts";
import { cut } from "#office/domain/text.ts";
import {
  attr,
  child,
  childrenOf,
  coreTitle,
  find,
  findAll,
  kids,
  openPackage,
  parseXml,
  tagOf,
  textOf,
  type XNode,
} from "#office/adapters/parse/ooxml.ts";

interface Paragraph {
  type: "paragraph";
  at: string;
  text: string;
  /** 0 = title, 1–9 = heading level, undefined = body text. */
  heading?: number;
  list: boolean;
}

interface Table {
  type: "table";
  at: string;
  rows: string[][];
}

type Block = Paragraph | Table;

interface Style {
  name: string;
  outline?: number;
  basedOn?: string;
}

async function readStyles(xml: string | null): Promise<Map<string, Style>> {
  const styles = new Map<string, Style>();
  if (!xml) return styles;
  for (const style of findAll(parseXml(xml), "w:style")) {
    const id = attr(style, "w:styleId");
    if (!id) continue;
    const name = attr(child(style, "w:name") ?? {}, "w:val") ?? id;
    const pPr = child(style, "w:pPr");
    const outline = pPr && attr(child(pPr, "w:outlineLvl") ?? {}, "w:val");
    const basedOn = attr(child(style, "w:basedOn") ?? {}, "w:val");
    styles.set(id, { name, outline: outline === undefined ? undefined : Number(outline), basedOn });
  }
  return styles;
}

function headingLevel(styles: Map<string, Style>, styleId: string | undefined, direct?: number) {
  if (direct !== undefined && direct < 9) return direct + 1;
  for (let id = styleId, depth = 0; id && depth < 10; depth++) {
    const style = styles.get(id);
    if (!style) break;
    if (/^title$/i.test(style.name)) return 0;
    const named = /^heading\s*(\d)$/i.exec(style.name);
    if (named) return Number(named[1]);
    if (style.outline !== undefined && style.outline < 9) return style.outline + 1;
    id = style.basedOn;
  }
  return undefined;
}

/** Visible text of a run container: w:t, tabs and breaks; deleted text and field codes are skipped. */
function runText(nodes: XNode[]): string {
  let out = "";
  for (const node of nodes) {
    const tag = tagOf(node);
    if (tag === "w:t")
      out += kids(node)
        .map((item) => textOf(item) ?? "")
        .join("");
    else if (tag === "w:tab" || tag === "w:ptab") out += "\t";
    else if (tag === "w:br" || tag === "w:cr") out += "\n";
    else if (tag === "w:noBreakHyphen") out += "-";
    else if (tag === "w:sym") out += "";
    else if (
      tag === "w:del" ||
      tag === "w:instrText" ||
      tag === "w:delText" ||
      tag === "w:pPr" ||
      tag === "w:rPr"
    )
      continue;
    else if (tag !== "#text") out += runText(kids(node));
  }
  return out;
}

function cellText(cell: XNode): string {
  const lines: string[] = [];
  const walk = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === "w:p") lines.push(runText(kids(node)));
      else if (tag === "w:tbl")
        for (const row of findAll(kids(node), "w:tc")) lines.push(cellText(row));
      else if (tag !== "w:tcPr") walk(kids(node));
    }
  };
  walk(kids(cell));
  return lines.join("\n").trim();
}

function blockText(block: Block): string {
  return block.type === "paragraph" ? block.text : block.rows.map((row) => row.join(" ")).join(" ");
}

function renderBlock(block: Block): string {
  if (block.type === "table") return `[${block.at}]\n${markdownTable(block.rows)}`;
  const text = block.text.trim();
  if (!text) return `[${block.at}] (empty)`;
  if (block.heading !== undefined)
    return `[${block.at}] ${"#".repeat(Math.max(1, block.heading))} ${text}`;
  return `[${block.at}] ${block.list ? "- " : ""}${text}`;
}

export async function parseDocx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {
  const pkg = await openPackage(bytes, label);
  const xml = await pkg.text("word/document.xml");
  if (!xml) throw new OfficeError("corrupt_file", `${label} has no word/document.xml.`);
  const styles = await readStyles(await pkg.text("word/styles.xml"));
  const body = find(parseXml(xml), "w:body");
  const blocks: Block[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];

  const walk = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === "w:p") {
        const pPr = child(node, "w:pPr");
        const styleId = pPr && attr(child(pPr, "w:pStyle") ?? {}, "w:val");
        const outline = pPr && attr(child(pPr, "w:outlineLvl") ?? {}, "w:val");
        const style = styleId ? styles.get(styleId)?.name : undefined;
        const paragraph: Paragraph = {
          type: "paragraph",
          at: `p:${paragraphs.length + 1}`,
          text: runText(kids(node)).replace(/\s+$/, ""),
          heading: headingLevel(
            styles,
            styleId,
            outline === undefined ? undefined : Number(outline),
          ),
          list: Boolean(pPr && child(pPr, "w:numPr")) || /^list/i.test(style ?? ""),
        };
        paragraphs.push(paragraph);
        blocks.push(paragraph);
      } else if (tag === "w:tbl") {
        const rows = childrenOf(node, "w:tr").map((row) =>
          findAll(kids(row), "w:tc").map(cellText),
        );
        const table: Table = { type: "table", at: `t:${tables.length + 1}`, rows };
        tables.push(table);
        blocks.push(table);
      } else if (tag === "w:sdt") {
        walk(kids(child(node, "w:sdtContent") ?? {}));
      } else if (tag === "w:customXml" || tag === "w:smartTag") {
        walk(kids(node));
      }
    }
  };
  walk(body ? kids(body) : []);

  const outline: OutlineItem[] = paragraphs
    .filter((p) => p.heading !== undefined && p.heading <= 3 && p.text.trim())
    .slice(0, 200)
    .map((p) => ({
      at: p.at,
      label: cut(normalise(p.text), 0, 120),
      level: Math.max(1, p.heading!),
    }));
  const title =
    (await coreTitle(pkg)) ??
    paragraphs.find((p) => p.heading !== undefined && p.text.trim())?.text.trim() ??
    null;

  function select(locator: Locator | null): Block[] {
    if (!locator) return blocks;
    if (locator.kind !== "docx")
      throw new OfficeError("invalid_anchor", "Not a Word document location.");
    if (locator.type === "paragraph") {
      const { from, to } = clampRange(locator.from, locator.to, paragraphs.length, "paragraph");
      return paragraphs.slice(from - 1, to);
    }
    const table = tables[locator.table - 1];
    if (!table)
      throw new OfficeError(
        "invalid_anchor",
        `Table ${locator.table} does not exist; the document has ${tables.length}.`,
      );
    if (!locator.cell) return [table];
    const value = table.rows[locator.cell.row - 1]?.[locator.cell.col - 1];
    if (value === undefined)
      throw new OfficeError(
        "invalid_anchor",
        `Cell r${locator.cell.row}c${locator.cell.col} is outside ${table.at}.`,
      );
    return [
      {
        type: "paragraph",
        at: `${table.at}/r${locator.cell.row}c${locator.cell.col}`,
        text: value,
        list: false,
      },
    ];
  }

  return {
    kind: "docx",
    title,
    units: blocks.length,
    outline,
    blocks: blocks.map((block) => ({
      at: block.at,
      text: cut(normalise(blockText(block)), 0, 400),
    })),
    read(locator, cursor) {
      return paginate(select(locator).map(renderBlock), cursor);
    },
    check(locator) {
      select(locator);
      return locator;
    },
    search(query, limit) {
      const hits: Hit[] = [];
      for (const block of blocks) {
        if (block.type === "paragraph") {
          for (const index of matchAll(block.text, query)) {
            hits.push({ at: block.at, snippet: snippet(block.text, index, query.length) });
            break;
          }
        } else {
          block.rows.forEach((row, r) =>
            row.forEach((value, c) => {
              const index = matchAll(value, query)[0];
              if (index !== undefined)
                hits.push({
                  at: `${block.at}/r${r + 1}c${c + 1}`,
                  snippet: snippet(value, index, query.length),
                });
            }),
          );
        }
        if (hits.length >= limit) break;
      }
      return hits.slice(0, limit);
    },
  };
}
