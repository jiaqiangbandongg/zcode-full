import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  GEN_UI_HTML_MAX_BYTES,
  genUiStateTargetSchema,
  type GenUiDocument,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";

export function assertGenUiFragment(html: string): void {
  if (Buffer.byteLength(html, "utf8") > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI file exceeds 5 MB");
  if (/<(?:!doctype\b|\/?(?:html|head|body)(?:\s|>))/iu.test(html))
    throw new Error("Gen UI requires an HTML fragment");
}
export async function readGenUiDocument(
  raw: GenUiStateTarget,
  outputRoot: string,
): Promise<GenUiDocument> {
  const input = genUiStateTargetSchema.parse(raw);
  if (!isAbsolute(outputRoot) || !isAbsolute(input.path) || !isAbsolute(input.workspacePath))
    throw new Error("Invalid executor path");
  const root = resolve(outputRoot),
    file = normalize(input.path);
  const child = relative(root, file);
  // 根因：fork 会保留父会话的 HTML 路径，生成目录分组不能作为当前会话的读取限制。
  // 读取范围只由执行端 Host 的固定输出根目录决定，widget state 仍使用当前会话身份。
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Gen UI file is outside the host output directory");
  // 修复依据：realpath 后再做前缀判断仍可能放行替换中的符号链接；逐级拒绝链接并核对打开的文件身份。
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Gen UI does not read symbolic links");
  }
  const before = await lstat(current);
  const canonicalFile = await realpath(current);
  const canonicalChild = relative(canonicalRoot, canonicalFile);
  if (
    !canonicalChild ||
    canonicalChild === ".." ||
    canonicalChild.startsWith(`..${sep}`) ||
    isAbsolute(canonicalChild)
  )
    throw new Error("Gen UI file escaped the output directory");
  if (!before.isFile() || before.size > GEN_UI_HTML_MAX_BYTES)
    throw new Error("Gen UI requires a regular file under 5 MB");
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Gen UI file changed while opening");
    const bytes = Buffer.alloc(GEN_UI_HTML_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > GEN_UI_HTML_MAX_BYTES) throw new Error("Gen UI file exceeds 5 MB");
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    assertGenUiFragment(html);
    return { path: file, html };
  } finally {
    await handle.close();
  }
}
