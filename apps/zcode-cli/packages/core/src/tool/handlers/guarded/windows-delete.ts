import type { RuleMatch } from "./git.js";
import type { CommandWord } from "./word.js";

/** CMD 内建删除：斜杠开关只在 CMD 分支解释；独立帮助不是删除调用。 */
export function matchCmdDelete(name: string, args: CommandWord[]): RuleMatch {
  if (args.length === 1 && args[0]!.value === "/?" && !args[0]!.dynamic) return false;
  const tree = name === "rd" || name === "rmdir";
  let recursive = false;
  let target = false;
  let unsupported = false;
  for (const word of args) {
    const value = word.value.toUpperCase();
    if (!value.startsWith("/") || word.dynamic) {
      target = true;
      continue;
    }
    for (const option of value.slice(1).split("/")) {
      if (option === "S") recursive = true;
      else if (
        !["Q", "?", ...(!tree ? ["P", "F"] : [])].includes(option) &&
        !(!tree && /^A(?::?[-RASHIO]*)$/.test(option))
      )
        unsupported = true;
    }
  }
  if (target && (!tree || recursive)) return tree ? "cmd-remove-tree" : "cmd-delete-files";
  return unsupported ? undefined : false;
}

const ROBOCOPY_FLAGS = new Set(
  "/MIR /PURGE /L /S /E /Z /B /ZB /J /EFSRAW /SEC /COPYALL /NOCOPY /SECFIX /TIMFIX /CREATE /FAT /256 /PF /SJ /SL /NODCOPY /NOOFFLOAD /COMPRESS /A /M /XC /XN /XO /XX /XL /IM /IS /IT /XJ /FFT /DST /XJD /XJF /TBD /LFSM /X /V /TS /FP /BYTES /NS /NC /NFL /NDL /NP /ETA /TEE /NJH /NJS /UNICODE /NP /?".split(
    " ",
  ),
);
const ROBOCOPY_VALUES = new Set(
  "/LEV /COPY /DCOPY /A+ /A- /MON /MOT /RH /IPG /MT /IOMAXSIZE /IORATE /THRESHOLD /IA /XA /MAX /MIN /MAXAGE /MINAGE /MAXLAD /MINLAD /R /W /LFSM /LOG /LOG+ /UNILOG /UNILOG+".split(
    " ",
  ),
);

/** Robocopy 值选项用冒号绑定；XF/XD 列表遇到下一个斜杠开关结束。 */
export function matchRobocopyDelete(args: CommandWord[], dialect: "cmd" | "git-bash"): RuleMatch {
  if (args.length < 2) return false;
  let deletion = false;
  let listOnly = false;
  let paths = 0;
  let exclusions = false;
  for (const word of args) {
    const value = word.value.toUpperCase();
    if (word.dynamic) return deletion ? "robocopy-delete" : undefined;
    // Git Bash 会把 /c/... 转为 Windows 盘符路径；这是 argv 语法，不是未知斜杠开关。
    // 必须有盘符后的 /，避免把 /L 等真实开关当路径；未知开关的 arity 策略不变。
    const drivePath = dialect === "git-bash" && /^\/[a-z]\//i.test(word.value);
    if (!value.startsWith("/") || drivePath) {
      if (!exclusions) paths++;
      continue;
    }
    exclusions = value === "/XF" || value === "/XD";
    if (value === "/MIR" || value === "/PURGE") deletion = true;
    else if (value === "/L") listOnly = true;
    else if (value === "/XF" || value === "/XD" || ROBOCOPY_FLAGS.has(value)) continue;
    else if (value.includes(":") && ROBOCOPY_VALUES.has(value.split(":", 1)[0]!)) continue;
    // JOB 与未知 arity 后不能生成豁免，也不能撤销之前明确定位的删除。
    else return deletion ? "robocopy-delete" : undefined;
  }
  return paths >= 2 && deletion && !listOnly && "robocopy-delete";
}
