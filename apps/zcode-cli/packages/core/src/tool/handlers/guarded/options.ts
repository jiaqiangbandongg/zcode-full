import type { CommandWord } from "./word.js";

export type OptionArity = "flag" | "value" | "optional";
export type OptionTable = Readonly<Record<string, OptionArity>>;
export interface ParsedOptions {
  flags: string[];
  operands: CommandWord[];
  unsupported: boolean;
}

/**
 * 扫描策略必须由调用方显式声明，没有默认值。
 * - ordering：wrapper/前置参数在首个操作数停止；目标命令自身允许选项与操作数交错。
 * - unknown：wrapper 遇到未知选项猜不出真实命令从哪开始，只能 abort；
 *   目标命令的存在性规则（rm -rf、--delete、--force）不因后面多一个未知词而失效，
 *   continue 只标记 unsupported、不消费下一个词、不进入 flags，让调用方按"命中优先"收敛。
 */
export interface OptionScanPolicy {
  ordering: "stop-at-operand" | "interspersed";
  unknown: "abort" | "continue";
}

export const WRAPPER_SCAN: OptionScanPolicy = {
  ordering: "stop-at-operand",
  unknown: "abort",
};
export const COMMAND_SCAN: OptionScanPolicy = {
  ordering: "interspersed",
  unknown: "continue",
};

/** 有限选项文法：先消耗已声明 arity 的参数值；未知选项不猜 arity。 */
export function parseOptions(
  words: CommandWord[],
  table: OptionTable,
  policy: OptionScanPolicy,
): ParsedOptions {
  const result: ParsedOptions = { flags: [], operands: [], unsupported: false };
  let ended = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!ended && !word.dynamic && word.value === "--") {
      ended = true;
      continue;
    }
    if (ended || word.dynamic || !word.value.startsWith("-") || word.value === "-") {
      result.operands.push(word);
      if (policy.ordering === "stop-at-operand") {
        result.operands.push(...words.slice(i + 1));
        break;
      }
      continue;
    }
    const long = word.value.startsWith("--");
    const equals = word.value.indexOf("=");
    const names = long
      ? [equals < 0 ? word.value : word.value.slice(0, equals)]
      : Array.from(word.value.slice(1), (c) => `-${c}`);
    for (let n = 0; n < names.length; n++) {
      const name = names[n]!;
      const arity = table[name];
      const attached = long ? equals >= 0 : n < names.length - 1;
      // 根因（2026-09-17 review）：此前未知选项直接 return，把 `rm -rfx` 中已识别的 -r/-f 一并丢弃，
      // 整条命令退回 YOLO 静默执行。abort 仅保留给 wrapper/前置参数。
      if (!arity || (arity === "flag" && long && attached)) {
        result.unsupported = true;
        if (policy.unknown === "abort") return result;
        continue;
      }
      result.flags.push(name);
      if (arity === "value" && !attached) {
        if (!words[++i]) result.unsupported = true;
      }
      if (arity !== "flag") break;
    }
  }
  return result;
}

export function optionTable(flags: string, values = "", optional = ""): OptionTable {
  return Object.fromEntries([
    ...flags
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "flag"]),
    ...values
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "value"]),
    ...optional
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => [name, "optional"]),
  ]);
}

export function enabled(flags: string[], yes: string[], no: string[] = []): boolean {
  let result = false;
  for (const flag of flags) {
    if (yes.includes(flag)) result = true;
    if (no.includes(flag)) result = false;
  }
  return result;
}

/** 命中优先：有可靠命中就返回规则；否则遇到过未知选项为 unsupported，否则为已支持未命中。 */
export function settleRule(
  rule: string | false,
  parsed: Pick<ParsedOptions, "unsupported">,
): string | false | undefined {
  return rule || (parsed.unsupported ? undefined : false);
}
