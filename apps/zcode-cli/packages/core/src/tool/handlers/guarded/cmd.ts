import type { CommandWord } from "./word.js";

const CMD_DELETE_BUILTIN = /^(?:rd|rmdir|del|erase)$/i;

/** CMD 的有限入口：双引号与 caret；单引号是普通字符。复杂块/变量展开不解释。 */
export function analyzeCmdCommand(source: string): {
  commands: CommandWord[][];
  unsupported: boolean;
} {
  const commands: CommandWord[][] = [];
  let words: CommandWord[] = [];
  let value = "";
  let start = -1;
  let quote = false;
  let dynamic = false;
  let hasUnquotedGlob = false;
  let skipTarget = false;
  let unsupported = false;
  let invalidSegment = false;
  let blockDepth = 0;
  const flushWord = (end: number) => {
    if (start < 0) return;
    if (!skipTarget) words.push({ value, dynamic, hasUnquotedGlob, start, end });
    skipTarget = false;
    value = "";
    start = -1;
    dynamic = false;
    hasUnquotedGlob = false;
  };
  const flushCommand = (end: number) => {
    flushWord(end);
    if (
      !invalidSegment &&
      blockDepth === 0 &&
      words.length &&
      !/^(?:rem|::)$/i.test(words[0]!.value)
    )
      commands.push(words);
    words = [];
    invalidSegment = blockDepth > 0;
  };
  const splitDeleteSwitch = (index: number) => {
    // CMD 内建删除允许 rd/s/q、target/s/q；caret 先被 CMD 去除，引用路径仍是完整词。
    // 仅拆这四个内建命令，不能把其它命令的路径或重定向目标按开关切开。
    if (!skipTarget && CMD_DELETE_BUILTIN.test(words[0]?.value ?? value)) {
      flushWord(index);
      start = index;
    }
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (!quote && c === "^") {
      if (start < 0) start = i;
      if (source[i + 1] === undefined || /[\r\n]/.test(source[i + 1]!)) {
        unsupported = true;
        invalidSegment = true;
      } else {
        if (source[i + 1] === "/") splitDeleteSwitch(i);
        value += source[++i];
      }
      continue;
    }
    if (c === '"') {
      if (start < 0) start = i;
      quote = !quote;
      continue;
    }
    if (!quote && /[ \t]/.test(c)) {
      flushWord(i);
      continue;
    }
    if (!quote && /[&|\r\n]/.test(c)) {
      flushCommand(i);
      if (source[i + 1] === c) i++;
      continue;
    }
    if (!quote && /[<>]/.test(c)) {
      // 2>&1 等 fd 重定向不是命令分隔符，也不是 argv。
      if (start >= 0 && /^\d+$/.test(value)) {
        value = "";
        start = -1;
      }
      flushWord(i);
      if (source[i + 1] === c) i++;
      if (source[i + 1] === "&" && /[\d-]/.test(source[i + 2] ?? "")) {
        i += 2;
      } else skipTarget = true;
      continue;
    }
    if (!quote && /[()]/.test(c)) {
      unsupported = true;
      invalidSegment = true;
      blockDepth = c === "(" ? blockDepth + 1 : Math.max(0, blockDepth - 1);
    }
    if (!quote && c === "/") splitDeleteSwitch(i);
    if (start < 0) start = i;
    if (c === "%" || c === "!") dynamic = true;
    if (!quote && /[*?[]/.test(c)) hasUnquotedGlob = true;
    value += c;
    // 重定向目标 rem 是文件名；只有命令位置的 REM 才能吞掉剩余注释文本。
    if (!quote && !skipTarget && words.length === 0 && /^(?:rem\s|::)/i.test(source.slice(start))) {
      const newline = source.indexOf("\n", i);
      value = "";
      start = -1;
      i = newline < 0 ? source.length : newline;
    }
  }
  // 根因（2026-09-17 review）：skipTarget 在目标词尚未 flush 时仍为 true，曾把 `git reset --hard 2>nul`
  // 这类以重定向目标结尾的命令整条判成"缺目标"。只有重定向符后没有开始任何目标词才是缺目标；
  // 目标词已在累积（start >= 0）时由下方 flushCommand 按重定向目标正常丢弃。
  if (quote || (skipTarget && start < 0)) {
    unsupported = true;
    invalidSegment = true;
  }
  flushCommand(source.length);
  return { commands, unsupported };
}
