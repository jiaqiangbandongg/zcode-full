import { genUiReferenceSchema, type GenUiReference } from "@zcode/shared/gen-ui";
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
} from "../../lib/assistantDirectiveParser.js";
export type GenUiPart =
  | { kind: "text"; text: string }
  | { kind: "ui"; reference: GenUiReference; offset: number }
  | { kind: "pending" | "invalid" };
interface ReferenceCandidate {
  start: number;
  end: number;
  decode(): unknown;
}
// 引用字段均为字符串；完整字符串后仍可能停在 key、冒号、value 或逗号处。
// 仅识别 JSON 参数前缀，不能把缺失右括号后出现的普通正文一起隐藏。
const jsonString = String.raw`"(?:[^"\\\r\n]|\\.)*"`;
const jsonParameterPrefix = new RegExp(
  String.raw`^\s*(?:${jsonString}\s*:\s*${jsonString}\s*,\s*)*(?:${jsonString}(?:\s*:\s*(?:${jsonString})?)?)?\s*$`,
);
export function projectGenUiReferences(text: string, completed: boolean): GenUiPart[] {
  const ranges = findMarkdownCodeRanges(text);
  const parts: GenUiPart[] = [];
  // 实际模型即使读到 Unicode 示例也会输出 ::visualize；复用既有参数解析后统一校验，
  // 避免正文被当作普通文字，也避免绕过代码区排除、完成门槛或执行端路径约束。
  const candidates: ReferenceCandidate[] = extractAssistantDirectives(text, "visualize").map(
    (directive) => ({
      ...directive,
      // 实际回复会保留 skill 的 JSON 参数但输出 ::visualize 前缀；通用 directive
      // 只解析 key=value，需在 Gen UI 内解码 JSON，再走同一严格 schema，不能放宽其他指令。
      decode: () =>
        directive.parameters ?? JSON.parse(directive.raw.slice(directive.raw.indexOf("{"))),
    }),
  );
  const unclosed = findUnclosedAssistantDirectiveStart(text, "visualize", ranges, {
    isParameterPrefix: (source) => jsonParameterPrefix.test(source),
  });
  if (unclosed !== null) candidates.push({ start: unclosed, end: text.length, decode: () => null });
  for (const match of text.matchAll(/visualize/gu)) {
    const start = match.index;
    const end = text.indexOf("", start + match[0].length);
    candidates.push({
      start,
      end: end < 0 ? text.length : end + 1,
      decode: () => (end < 0 ? null : JSON.parse(text.slice(start + match[0].length, end))),
    });
  }
  let cursor = 0;
  for (const candidate of candidates.sort((left, right) => left.start - right.start)) {
    const { start, end } = candidate;
    if (ranges.some(([from, to]) => start >= from && start < to) || start < cursor) continue;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    cursor = end;
    if (!completed) {
      parts.push({ kind: "pending" });
      continue;
    }
    try {
      const reference = genUiReferenceSchema.parse(candidate.decode());
      parts.push({ kind: "ui", reference, offset: start });
    } catch {
      parts.push({ kind: "invalid" });
    }
  }
  let tailEnd = text.length;
  if (!completed) {
    const prefix = findAssistantDirectivePrefixStart(text, ["visualize"], ranges);
    if (prefix !== null && prefix >= cursor) tailEnd = prefix;
    const index = text.lastIndexOf("");
    if (
      index >= cursor &&
      !ranges.some(([from, to]) => index >= from && index < to) &&
      "visualize".startsWith(text.slice(index))
    )
      tailEnd = Math.min(tailEnd, index);
  }
  const tail = text.slice(cursor, tailEnd);
  if (tail) parts.push({ kind: "text", text: tail });
  return parts;
}
