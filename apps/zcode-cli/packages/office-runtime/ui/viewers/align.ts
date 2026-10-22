import type { DocxBlockKey } from "#office/contract.ts";

const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/**
 * Map rendered docx elements (paragraphs and top-level tables, in document order) to the server's
 * block list by text. A paragraph split across pages renders as several elements; they all map to
 * the same block. Elements that cannot be matched within a small look-ahead stay unmapped.
 */
export function alignBlocks(
  elements: { text: string; table: boolean }[],
  blocks: DocxBlockKey[],
): (string | null)[] {
  const keys = blocks.map((block) => ({
    at: block.at,
    table: block.at.startsWith("t:"),
    text: squash(block.text),
  }));
  const result: (string | null)[] = [];
  let j = 0;
  let consumed = 0; // characters of keys[j].text already matched by earlier fragments
  const LOOKAHEAD = 6;
  for (const element of elements) {
    const text = squash(element.text);
    let matched: number | null = null;
    if (j < keys.length && consumed > 0) {
      // Continuation of a paragraph split across pages.
      const rest = keys[j].text.slice(consumed);
      if (text && !element.table && rest.startsWith(text)) {
        consumed += text.length;
        result.push(keys[j].at);
        if (consumed >= keys[j].text.length) {
          j++;
          consumed = 0;
        }
        continue;
      }
      j++;
      consumed = 0;
    }
    for (let k = j; k < Math.min(keys.length, j + LOOKAHEAD); k++) {
      const key = keys[k];
      if (key.table !== element.table) continue;
      // Server text is clipped to 400 characters; compare on the shared prefix.
      const probe = text.slice(0, key.text.length);
      if (
        key.text === text ||
        (text && key.text.startsWith(text)) ||
        (key.text.length >= 300 && probe === key.text)
      ) {
        matched = k;
        break;
      }
      if (!text && !key.text) {
        matched = k;
        break;
      }
    }
    if (matched === null) {
      result.push(null);
      continue;
    }
    result.push(keys[matched].at);
    const key = keys[matched];
    if (
      text &&
      !element.table &&
      text.length < key.text.length &&
      key.text.startsWith(text) &&
      key.text.length < 400
    ) {
      j = matched;
      consumed = text.length;
    } else {
      j = matched + 1;
      consumed = 0;
    }
  }
  return result;
}
