/**
 * JavaScript strings are UTF-16: characters outside the basic plane, such as the math letters
 * 𝑥 and 𝜃 that PDFs use, take two code units. Cutting between them leaves half a character,
 * which cannot be encoded as UTF-8, and model APIs reject the whole request ("surrogates not
 * allowed"). Every place that shortens text goes through `cut`, and everything sent to the host
 * goes through `wellFormed`.
 */

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text.slice(start, end)`, moved off the middle of a two-unit character at either end. */
export function cut(text: string, start: number, end = text.length): string {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  if (from > 0 && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from--;
  if (to < text.length && isLow(text.charCodeAt(to)) && isHigh(text.charCodeAt(to - 1))) to--;
  return text.slice(from, to);
}

const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace any half character left in `text` with U+FFFD. */
export const wellFormed = (text: string): string => text.replace(LONE_HALF, "�");

/** `wellFormed` applied to every string inside a JSON-like value. */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wellFormedDeep(item)]),
    ) as T;
  return value;
}
