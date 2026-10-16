import { optionTable, parseOptions, WRAPPER_SCAN } from "./options.js";
import { commandBasename, type CommandWord } from "./word.js";

const WRAPPERS = {
  env: optionTable("-i --ignore-environment -0 --null -v --debug", "-u --unset -C --chdir"),
  time: optionTable(
    "-a --append -p --portability -v --verbose -q --quiet",
    "-o --output -f --format",
  ),
  sudo: optionTable(
    "-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -S --stdin",
    "-u --user -g --group -h --host -p --prompt -C --close-from -T --command-timeout -D --chdir -R --chroot",
  ),
} as const;

export function unwrapCommand(input: CommandWord[], windows: boolean): CommandWord[] | undefined {
  let words = input;
  while (words.length) {
    const name = commandBasename(words[0]!, windows);
    if (!name) return undefined;
    if (!(name in WRAPPERS)) return words;
    // wrapper 的未知选项决定真实命令从哪个词开始，猜不出只能整体放弃。
    const parsed = parseOptions(
      words.slice(1),
      WRAPPERS[name as keyof typeof WRAPPERS],
      WRAPPER_SCAN,
    );
    if (parsed.unsupported) return undefined;
    words = parsed.operands;
    if (name === "env" || name === "sudo") {
      while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1);
    }
  }
  return undefined;
}
