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
  readRels,
  tagOf,
  textOf,
  type Package,
  type XNode,
} from "#office/adapters/parse/ooxml.ts";

interface Shape {
  id: string;
  name: string;
  kind: "text" | "picture" | "table" | "chart" | "group" | "connector" | "other";
  placeholder?: string;
  text: string;
  rows?: string[][];
}

interface Slide {
  index: number;
  hidden: boolean;
  title: string | null;
  shapes: Shape[];
  notes: string;
}

function paragraphsText(txBody: XNode | undefined): string {
  if (!txBody) return "";
  return childrenOf(txBody, "a:p")
    .map((paragraph) => {
      let line = "";
      for (const node of kids(paragraph)) {
        const tag = tagOf(node);
        if (tag === "a:r" || tag === "a:fld") {
          const t = child(node, "a:t");
          line += t
            ? kids(t)
                .map((item) => textOf(item) ?? "")
                .join("")
            : "";
        } else if (tag === "a:br") line += "\n";
      }
      return line;
    })
    .join("\n")
    .trim();
}

function readShapes(nodes: XNode[], out: Shape[]) {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!["p:sp", "p:pic", "p:graphicFrame", "p:grpSp", "p:cxnSp"].includes(tag)) continue;
    const nv = kids(node).find((item) => tagOf(item).startsWith("p:nv"));
    const cNvPr = nv && child(nv, "p:cNvPr");
    const id = (cNvPr && attr(cNvPr, "id")) ?? "";
    const name = (cNvPr && attr(cNvPr, "name")) ?? "";
    const ph = nv && find(kids(nv), "p:ph");
    const placeholder = ph ? (attr(ph, "type") ?? "body") : undefined;
    if (tag === "p:sp") {
      out.push({
        id,
        name,
        kind: "text",
        placeholder,
        text: paragraphsText(child(node, "p:txBody")),
      });
    } else if (tag === "p:pic") {
      const descr = cNvPr && attr(cNvPr, "descr");
      out.push({
        id,
        name,
        kind: "picture",
        placeholder,
        text: descr ? `(image: ${descr})` : "(image)",
      });
    } else if (tag === "p:cxnSp") {
      out.push({ id, name, kind: "connector", text: "" });
    } else if (tag === "p:graphicFrame") {
      const table = find(kids(node), "a:tbl");
      if (table) {
        const rows = childrenOf(table, "a:tr").map((row) =>
          childrenOf(row, "a:tc").map((cell) => paragraphsText(child(cell, "a:txBody"))),
        );
        out.push({ id, name, kind: "table", text: "", rows });
      } else {
        const data = find(kids(node), "a:graphicData");
        const uri = (data && attr(data, "uri")) ?? "";
        out.push({
          id,
          name,
          kind: /chart/i.test(uri) ? "chart" : "other",
          text: /chart/i.test(uri) ? "(chart)" : "",
        });
      }
    } else if (tag === "p:grpSp") {
      // The group carries its members' text so a click on the group (the viewer's hit target) reads well.
      const members: Shape[] = [];
      readShapes(kids(node), members);
      const text = members
        .map((member) =>
          member.rows ? member.rows.map((row) => row.join(" | ")).join("\n") : member.text,
        )
        .filter(Boolean)
        .join("\n");
      out.push({ id, name, kind: "group", text }, ...members);
    }
  }
}

async function readNotes(pkg: Package, slidePath: string): Promise<string> {
  const rels = await readRels(pkg, slidePath);
  const notes = [...rels.values()].find((rel) => rel.type.endsWith("/notesSlide"));
  if (!notes) return "";
  const xml = await pkg.text(notes.target);
  if (!xml) return "";
  const shapes: Shape[] = [];
  readShapes(kids(find(parseXml(xml), "p:spTree") ?? {}), shapes);
  return shapes
    .filter((shape) => shape.placeholder === "body")
    .map((shape) => shape.text)
    .join("\n")
    .trim();
}

function renderShape(shape: Shape): string {
  const label = `[shape:${shape.id} ${shape.kind}${shape.name ? ` "${shape.name}"` : ""}]`;
  if (shape.kind === "table" && shape.rows) return `${label}\n${markdownTable(shape.rows)}`;
  if (!shape.text) return label;
  return shape.text.includes("\n")
    ? `${label}\n${shape.text.replace(/^/gm, "  ")}`
    : `${label} ${shape.text}`;
}

function renderSlide(slide: Slide, only?: Shape): string {
  const head = `## Slide ${slide.index}${slide.title ? `: ${slide.title}` : ""}${slide.hidden ? " (hidden)" : ""}`;
  const shapes = (only ? [only] : slide.shapes).filter((shape) => shape.kind !== "group" || only);
  const parts = [head, ...shapes.map(renderShape)];
  if (!only && slide.notes) parts.push(`Speaker notes: ${slide.notes}`);
  return parts.join("\n");
}

export async function parsePptx(bytes: Uint8Array, label: string): Promise<ParsedDocument> {
  const pkg = await openPackage(bytes, label);
  const presentationXml = await pkg.text("ppt/presentation.xml");
  if (!presentationXml)
    throw new OfficeError("corrupt_file", `${label} has no ppt/presentation.xml.`);
  const rels = await readRels(pkg, "ppt/presentation.xml");
  const slideIds = findAll(parseXml(presentationXml), "p:sldId");
  const slides: Slide[] = [];
  for (const slideId of slideIds) {
    const rel = rels.get(attr(slideId, "r:id") ?? "");
    if (!rel) continue;
    const xml = await pkg.text(rel.target);
    if (!xml) continue;
    const doc = parseXml(xml);
    const root = find(doc, "p:sld");
    const shapes: Shape[] = [];
    readShapes(kids(find(doc, "p:spTree") ?? {}), shapes);
    const titleShape = shapes.find(
      (shape) => shape.placeholder === "title" || shape.placeholder === "ctrTitle",
    );
    slides.push({
      index: slides.length + 1,
      hidden: root ? attr(root, "show") === "0" : false,
      title: titleShape?.text ? normalise(titleShape.text) : null,
      shapes,
      notes: await readNotes(pkg, rel.target),
    });
  }

  const outline: OutlineItem[] = slides.map((slide) => ({
    at: `slide:${slide.index}`,
    label: slide.title ?? `Slide ${slide.index}`,
    level: 1,
  }));

  function select(locator: Locator | null): string[] {
    if (!locator) return slides.map((slide) => renderSlide(slide));
    if (locator.kind !== "pptx")
      throw new OfficeError("invalid_anchor", "Not a presentation location.");
    const { from, to } = clampRange(locator.from, locator.to, slides.length, "slide");
    if (locator.shape) {
      const slide = slides[from - 1];
      const shape = slide.shapes.find((item) => item.id === locator.shape);
      if (!shape)
        throw new OfficeError(
          "invalid_anchor",
          `Slide ${from} has no shape ${locator.shape}. Shapes: ${slide.shapes.map((item) => item.id).join(", ") || "none"}.`,
        );
      return [renderSlide(slide, shape)];
    }
    return slides.slice(from - 1, to).map((slide) => renderSlide(slide));
  }

  return {
    kind: "pptx",
    title: (await coreTitle(pkg)) ?? slides[0]?.title ?? null,
    units: slides.length,
    outline,
    read: (locator, cursor) => paginate(select(locator), cursor),
    check: (locator) => (select(locator), locator),
    search(query, limit) {
      const hits: Hit[] = [];
      for (const slide of slides) {
        for (const shape of slide.shapes) {
          if (shape.kind === "group") continue;
          const text = shape.rows
            ? shape.rows.map((row) => row.join(" | ")).join("\n")
            : shape.text;
          const index = matchAll(text, query)[0];
          if (index !== undefined)
            hits.push({
              at: `slide:${slide.index}/shape:${shape.id}`,
              snippet: snippet(text, index, query.length),
            });
        }
        const index = matchAll(slide.notes, query)[0];
        if (index !== undefined)
          hits.push({
            at: `slide:${slide.index}`,
            snippet: `(notes) ${snippet(slide.notes, index, query.length)}`,
          });
        if (hits.length >= limit) break;
      }
      return hits.slice(0, limit);
    },
  };
}
