import type { CSSProperties } from "react";

const COLOR_TOKEN =
  /^var\(--color-(foreground(?:-subtle|-subtlest|-inverse)?|primary(?:-foreground)?|secondary|brand|icon-blue|success|warning|destructive|popover|surface|background)\)$/;
const SIZE_TOKEN = /^var\(--text-ui-(xl|lg|base|caption|sm|xs)\)$/;
const ENUMS: Record<string, string[]> = {
  "font-style": ["normal", "italic", "oblique"],
  "text-align": ["start", "end", "left", "right", "center", "justify"],
  "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
  "overflow-wrap": ["normal", "break-word", "anywhere"],
  "word-break": ["normal", "break-all", "keep-all", "break-word"],
  "text-decoration-style": ["solid", "double", "dotted", "dashed", "wavy"],
};
function length(value: string): boolean {
  if (value === "0") return true;
  const match = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|em)$/.exec(value);
  return !!match && Number(match[1]) <= (match[2] === "px" ? 32 : 2);
}
function allowed(property: string, value: string): boolean {
  // CSS 解析之后仍禁止变量 fallback、转义和资源函数；不能只靠属性名单放行值。
  if (/[\\@!]|\/\*/.test(value)) return false;
  if (["color", "background-color", "text-decoration-color"].includes(property)) {
    return (
      COLOR_TOKEN.test(value) ||
      /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|oklch|oklab|lch|lab)\([\d.,% /+-]+\))$/i.test(value)
    );
  }
  if (property === "font-size") return SIZE_TOKEN.test(value);
  if (property === "font-weight")
    return (
      /^(normal|bold|bolder|lighter)$/.test(value) ||
      (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000)
    );
  if (property === "line-height")
    return (
      value === "normal" ||
      (/^\d+(?:\.\d+)?$/.test(value) && Number(value) >= 1 && Number(value) <= 3)
    );
  if (ENUMS[property]) return ENUMS[property]!.includes(value);
  if (property === "text-decoration" || property === "text-decoration-line") {
    const tokens = value.split(/\s+/);
    return (
      tokens.length <= 4 &&
      tokens.every((token) =>
        [
          "none",
          "underline",
          "overline",
          "line-through",
          ...(property === "text-decoration" ? ENUMS["text-decoration-style"]! : []),
        ].includes(token),
      )
    );
  }
  if (/^(margin|padding)(-(top|right|bottom|left))?$/.test(property)) {
    const tokens = value.split(/\s+/);
    return tokens.length <= (property.includes("-") ? 1 : 4) && tokens.every(length);
  }
  if (property === "letter-spacing") return value === "normal" || length(value);
  if (property === "text-underline-offset") return value === "auto" || length(value);
  if (property === "text-decoration-thickness")
    return ["auto", "from-font"].includes(value) || length(value);
  return false;
}

export function parseCloudDescriptionStyle(text: string | null): CSSProperties | undefined {
  if (!text) return undefined;
  // 未挂载元素上的 CSSOM 负责声明解析，不把原始 style 或 DOM 直接插入宿主。
  const parsed = document.createElement("span").style;
  parsed.cssText = text;
  const result: Record<string, string> = {};
  for (let index = 0; index < parsed.length; index++) {
    const property = parsed.item(index);
    const value = parsed.getPropertyValue(property).trim();
    if (parsed.getPropertyPriority(property) || !allowed(property, value)) continue;
    const key = property.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
    result[key] = value;
  }
  return Object.keys(result).length ? (result as CSSProperties) : undefined;
}
