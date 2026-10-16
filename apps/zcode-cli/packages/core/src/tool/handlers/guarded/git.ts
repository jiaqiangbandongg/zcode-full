import {
  COMMAND_SCAN,
  enabled,
  optionTable,
  parseOptions,
  settleRule,
  WRAPPER_SCAN,
} from "./options.js";
import type { CommandWord } from "./word.js";

// 前置参数走 abort 策略，未知即整体 unsupported，因此这里必须认识 -c/-p/-P/--exec-path 这类常见前置项；
// -c 只按取值 arity 跳过，不解释配置内容。
const FRONT = optionTable(
  "--no-pager -P --paginate -p --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --bare --no-replace-objects --no-optional-locks",
  "-C --git-dir --work-tree --namespace -c --config-env --super-prefix",
  "--exec-path",
);
const HELP = "-h --help";
const COMMON = `${HELP} -q --quiet -v --verbose`;
const RESET = optionTable(
  `${COMMON} --hard --soft --mixed --merge --keep -p --patch -N --intent-to-add --no-refresh --refresh --recurse-submodules --no-recurse-submodules`,
);
const CLEAN = optionTable(
  `${COMMON} -f --force -d -x -X -n --dry-run --no-dry-run -i --interactive`,
  "-e --exclude",
);
const PUSH = optionTable(
  `${COMMON} -f --force --no-force --mirror --no-mirror -n --dry-run --no-dry-run --no-force-with-lease --force-if-includes --no-force-if-includes --all --branches --tags --delete -d --prune --atomic --no-atomic --porcelain --follow-tags --no-follow-tags --set-upstream -u --thin --no-thin --progress --no-progress --ipv4 -4 --ipv6 -6`,
  "--repo --receive-pack --exec -o --push-option",
  "--force-with-lease --signed --recurse-submodules",
);
const CHECKOUT = optionTable(
  `${COMMON} -f --force --no-force --detach --ours --theirs -m --merge --conflict -p --patch --ignore-other-worktrees --recurse-submodules --no-recurse-submodules --no-overlay --overlay`,
  "-b -B --orphan --conflict",
);
const RESTORE = optionTable(
  `${COMMON} -W --worktree --no-worktree -S --staged --no-staged --ours --theirs -m --merge -p --patch --ignore-unmerged --overlay --no-overlay --recurse-submodules --no-recurse-submodules`,
  "-s --source --conflict",
);
const FORCE = ["-f", "--force"];
const TREE = new Set([".", "./", ":/"]);
export type RuleMatch = string | false | undefined;

/** false=已支持且未命中；undefined=超出当前命令/选项文法。 */
export function matchGit(words: CommandWord[]): RuleMatch {
  const front = parseOptions(words, FRONT, WRAPPER_SCAN);
  if (front.unsupported || front.operands[0]?.dynamic) return undefined;
  const [head, ...args] = front.operands;
  if (!head) return false;
  let table;
  switch (head.value) {
    case "reset":
      table = RESET;
      break;
    case "clean":
      table = CLEAN;
      break;
    case "push":
      table = PUSH;
      break;
    case "checkout":
      table = CHECKOUT;
      break;
    case "restore":
      table = RESTORE;
      break;
    case "stash": {
      if (args[0]?.dynamic) return undefined;
      if (args[0]?.value !== "clear") return false;
      const parsed = parseOptions(args.slice(1), optionTable(HELP), COMMAND_SCAN);
      return settleRule(!hasHelp(parsed.flags) && "git-stash-clear", parsed);
    }
    case "worktree": {
      if (args[0]?.dynamic) return undefined;
      if (args[0]?.value !== "remove") return false;
      const parsed = parseOptions(
        args.slice(1),
        optionTable(`${HELP} -f --force --no-force`),
        COMMAND_SCAN,
      );
      return settleRule(
        !hasHelp(parsed.flags) &&
          enabled(parsed.flags, FORCE, ["--no-force"]) &&
          "git-worktree-force-remove",
        parsed,
      );
    }
    default:
      return undefined;
  }
  const parsed = parseOptions(args, table, COMMAND_SCAN);
  const { flags, operands } = parsed;
  // Git 的 -h/--help 是可靠的查询退出；未知选项不改变这一点，也不抹去已识别的 force/hard。
  if (hasHelp(flags)) return false;
  const dryRun = enabled(flags, ["-n", "--dry-run"], ["--no-dry-run"]);
  const force = enabled(flags, FORCE, ["--no-force"]);
  switch (head.value) {
    case "reset":
      return settleRule(
        enabled(flags, ["--hard"], ["--soft", "--mixed", "--merge", "--keep", "-p", "--patch"]) &&
          "git-reset-hard",
        parsed,
      );
    case "clean":
      return settleRule(!dryRun && force && "git-clean-force", parsed);
    case "push": {
      const refspecs = flags.includes("--repo") ? operands : operands.slice(1);
      // glob 会让整词标为 dynamic，但已知的 + 前缀仍是强推证据。
      return settleRule(
        !dryRun &&
          (force ||
            enabled(flags, ["--force-with-lease"], ["--no-force-with-lease"]) ||
            enabled(flags, ["--mirror"], ["--no-mirror"]) ||
            refspecs.some((w) => w.value.startsWith("+"))) &&
          "git-push-force",
        parsed,
      );
    }
    case "checkout":
      return settleRule(
        (force || operands.some((w) => !w.dynamic && TREE.has(w.value))) && "git-discard-tree",
        parsed,
      );
    case "restore": {
      const stagedOnly =
        enabled(flags, ["-S", "--staged"], ["--no-staged"]) &&
        !enabled(flags, ["-W", "--worktree"], ["--no-worktree"]);
      return settleRule(
        !stagedOnly && operands.some((w) => !w.dynamic && TREE.has(w.value)) && "git-discard-tree",
        parsed,
      );
    }
    default:
      return false;
  }
}

function hasHelp(flags: string[]): boolean {
  return flags.includes("--help") || flags.includes("-h");
}
