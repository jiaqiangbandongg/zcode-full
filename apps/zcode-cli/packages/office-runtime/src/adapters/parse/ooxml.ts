import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { MAX_UNZIPPED_BYTES, OfficeError } from "#office/contract.ts";

/** Order-preserving XML node from fast-xml-parser: `{ [tag]: children, ":@"?: attributes }`. */
export type XNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Entities are never expanded: OOXML does not need them and expansion is an attack surface.
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** Decode the five XML entities and numeric references only. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

export function parseXml(text: string): XNode[] {
  return parser.parse(text) as XNode[];
}

export function tagOf(node: XNode): string {
  for (const key of Object.keys(node)) if (key !== ":@") return key;
  return "";
}

export function kids(node: XNode): XNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

export function attr(node: XNode, name: string): string | undefined {
  const attrs = node[":@"] as Record<string, string> | undefined;
  const value = attrs?.[name];
  return value === undefined ? undefined : decodeXml(String(value));
}

/** Text value of a `#text` node. */
export function textOf(node: XNode): string | null {
  return "#text" in node ? decodeXml(String(node["#text"])) : null;
}

export function child(node: XNode, tag: string): XNode | undefined {
  return kids(node).find((item) => tagOf(item) === tag);
}

export function childrenOf(node: XNode, tag: string): XNode[] {
  return kids(node).filter((item) => tagOf(item) === tag);
}

/** First element with the given tag in a document (depth-first). */
export function find(nodes: XNode[], tag: string): XNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const found = find(kids(node), tag);
    if (found) return found;
  }
  return undefined;
}

export function findAll(nodes: XNode[], tag: string, out: XNode[] = []): XNode[] {
  for (const node of nodes) {
    if (tagOf(node) === tag) out.push(node);
    else findAll(kids(node), tag, out);
  }
  return out;
}

export interface Package {
  has(path: string): boolean;
  text(path: string): Promise<string | null>;
  paths(): string[];
}

/** Open an OOXML zip with a zip-bomb guard on the declared uncompressed sizes. */
export async function openPackage(bytes: Uint8Array, label: string): Promise<Package> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new OfficeError(
      "corrupt_file",
      `${label} is not a valid Office file (cannot read the zip package).`,
    );
  }
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
  }
  if (total > MAX_UNZIPPED_BYTES)
    throw new OfficeError(
      "file_too_large",
      `${label} expands to more than ${MAX_UNZIPPED_BYTES / 1024 / 1024} MiB.`,
    );
  const normalise = (path: string) => path.replace(/^\/+/, "");
  return {
    has: (path) => Boolean(zip.file(normalise(path))),
    async text(path) {
      const file = zip.file(normalise(path));
      return file ? file.async("string") : null;
    },
    paths: () => Object.keys(zip.files),
  };
}

/** Resolve a relationship target relative to the part that owns the .rels file. */
export function resolveTarget(partPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = partPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** Read `<part>`'s relationships as id → { target (resolved), type, external }. */
export async function readRels(pkg: Package, partPath: string) {
  const dir = partPath.split("/").slice(0, -1).join("/");
  const name = partPath.split("/").pop();
  const xml = await pkg.text(`${dir ? `${dir}/` : ""}_rels/${name}.rels`);
  const rels = new Map<string, { target: string; type: string; external: boolean }>();
  if (!xml) return rels;
  for (const rel of findAll(parseXml(xml), "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    rels.set(id, {
      target: external ? target : resolveTarget(partPath, target),
      type: attr(rel, "Type") ?? "",
      external,
    });
  }
  return rels;
}

export async function coreTitle(pkg: Package): Promise<string | null> {
  const xml = await pkg.text("docProps/core.xml");
  if (!xml) return null;
  const title = find(parseXml(xml), "dc:title");
  const text = title
    ? kids(title)
        .map((node) => textOf(node) ?? "")
        .join("")
        .trim()
    : "";
  return text || null;
}
