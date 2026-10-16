import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { analyzeBashCommand } from "../src/tool/handlers/bash-command-parser.js";
import { matchDangerousCommand } from "../src/tool/handlers/guarded/command.js";
import { optionTable, parseOptions } from "../src/tool/handlers/guarded/options.js";

const matches = [
  [
    "remove-critical-path",
    "rm -rf build",
    "rm -f -R build",
    "rm --recursive --force build",
    'rm -rf "$target"',
    "rm -rf -- -i",
    "rm -rfi build",
  ],
  [
    "system-storage",
    "dd if=in of=out",
    "mount /dev/disk /mnt",
    "umount /mnt",
    "mkfs /dev/disk",
    "mkfs.ext4 /dev/disk",
  ],
  [
    "git-reset-hard",
    "git reset --hard",
    "git -C repo reset --hard HEAD",
    "git --git-dir=repo reset --hard",
  ],
  [
    "git-clean-force",
    "git clean -fd",
    "git clean -dfx",
    "git clean -f file",
    "git clean -f -- --dry-run",
  ],
  [
    "git-push-force",
    "git push -f origin main",
    "git push --force-with-lease",
    "git push --mirror",
    "git push origin +HEAD:main",
    "git push --force origin 'refs/heads/*:refs/heads/*'",
    "git push --force --no-dry-run",
    "git push --force-with-lease --no-force",
  ],
  [
    "git-discard-tree",
    "git checkout -f main",
    "git checkout HEAD -- .",
    "git restore .",
    "git restore --staged --worktree ./",
    "git restore --source=HEAD :/",
  ],
  ["git-stash-clear", "git stash clear"],
  ["git-worktree-force-remove", "git worktree remove -ff path", "git worktree remove --force path"],
  [
    "rsync-delete",
    "rsync -a --delete src/ dest/",
    "rsync --del src/ dest/",
    "rsync --delete-before src/ dest/",
    "rsync --delete-during src/ dest/",
    "rsync --delete-delay src/ dest/",
    "rsync --delete-after src/ dest/",
    "rsync --delete-excluded src/ dest/",
  ],
] as const;

describe("Guarded finite command contract", () => {
  for (const dialect of ["posix", "git-bash", "cmd"] as const) {
    it.each([
      "git push origin +refs/heads/*:refs/heads/*",
      'git push origin "+refs/heads/*:refs/heads/*"',
      'git push origin "+main"',
      'git push --force origin "refs/heads/*:refs/heads/*"',
      "git push --repo origin +refs/heads/*:refs/heads/*",
    ])(`recognizes force refspecs in ${dialect}: %s`, (command) => {
      expect(matchDangerousCommand(command, dialect)).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.git-push-force",
      });
    });
    it.each([
      "git push --dry-run origin +refs/heads/*:refs/heads/*",
      "git push -n origin +refs/heads/*:refs/heads/*",
      "git push origin refs/heads/*:refs/heads/*",
      'git push --push-option "+refs/heads/*:refs/heads/*" origin main',
      'git push --repo "+refs/heads/*:refs/heads/*" main',
      'git push "+refs/heads/*:refs/heads/*" main',
    ])(`preserves force refspec boundaries in ${dialect}: %s`, (command) => {
      expect(matchDangerousCommand(command, dialect).status).not.toBe("matched");
    });
  }

  for (const [id, ...commands] of matches) {
    it.each(commands)(`${id}: %s`, (command) => {
      expect(matchDangerousCommand(command, "posix")).toMatchObject({
        status: "matched",
        ruleId: `safety.bash.${id}`,
      });
    });
  }

  it.each([
    "env A=b rm -rf build",
    "env -u A rm -rf build",
    "time -o file rm -rf build",
    "/usr/bin/time --output=file rm -rf build",
    "sudo -u root rm -rf build",
    "env -C repo time -f '%e' sudo --user=root rm -rf build",
    "echo hello; rm -rf build",
    "false || rm -rf build",
    "true && rm -rf build",
    "echo hi | rm -rf build",
    '"/bin/rm" -rf build',
    "r\\m -rf build",
    "for x in a; do echo hi; done; rm -rf build",
  ])("recognizes reliable command nodes: %s", (command) => {
    expect(matchDangerousCommand(command, "posix").status).toBe("matched");
  });

  it.each([
    "rm -f file",
    "rm -- -rf",
    "rm --help",
    "rm --version",
    "mount",
    "dd --help",
    "mount --version",
    "mkfs --help",
    "git reset --soft HEAD",
    "git reset -- --hard",
    "git clean -nfd",
    "git clean -fd --dry-run",
    "git clean -fd -e --dry-run --dry-run",
    "git push -nf",
    "git push --force --no-force",
    "git push --force-if-includes",
    "git push --force-with-lease --no-force-with-lease",
    "git push --mirror --no-mirror",
    "git push --repo +not-a-refspec",
    "git push --push-option=--force",
    "git restore --staged .",
    "git restore file",
    "git checkout -b branch",
    "git checkout -b .",
    "git stash drop",
    "git worktree remove path",
    "rsync --delete -n src/ dest/",
    "rsync --exclude --delete src/ dest/",
    "rsync --filter=--delete src/ dest/",
    "echo 'rm -rf build'",
    "echo hi # rm -rf build",
    "echo hi > 'rm -rf build'",
    "time -o 'rm -rf build' echo ok",
    "sudo -u rm echo -rf build",
    "env A='rm -rf build' echo ok",
  ])("does not invent a destructive effect: %s", (command) => {
    expect(matchDangerousCommand(command, "posix").status).toBe("notMatched");
  });

  it.each([
    ["git clean -fd -e --dry-run", "git clean -fd --dry-run", "git-clean-force"],
    ["git clean -nfd --no-dry-run", "git clean -fd --no-dry-run -n", "git-clean-force"],
    ["git push -f --push-option --dry-run", "git push -f --dry-run", "git-push-force"],
    ["git push -nf --no-dry-run", "git push -f --no-dry-run -n", "git-push-force"],
    ["git push --mirror --no-force", "git push --mirror --no-mirror", "git-push-force"],
    ["rsync --delete --exclude --help src/ dest/", "rsync --delete --help", "rsync-delete"],
    [
      "rsync --delete --filter --dry-run src/ dest/",
      "rsync --delete -n src/ dest/",
      "rsync-delete",
    ],
  ])("keeps exemption words distinct from values/cancellation: %s", (dangerous, exempt, rule) => {
    expect(matchDangerousCommand(dangerous, "posix")).toMatchObject({
      status: "matched",
      ruleId: `safety.bash.${rule}`,
    });
    expect(matchDangerousCommand(exempt, "posix")).toEqual({ status: "notMatched" });
  });

  it.each([
    "bash -c 'rm -rf build'",
    "powershell -Command 'rm -rf build'",
    "eval 'rm -rf build'",
    "$exe -rf build",
    "git -c alias.wipe='reset --hard' wipe",
    "env -S 'rm -rf build'",
    "time --unknown rm -rf build",
    "for x in a; do rm -rf build; done",
    "rm 'unterminated",
    "x".repeat(10_001),
  ])("labels unsupported boundaries: %s", (command) => {
    expect(matchDangerousCommand(command, "posix").status).toBe("unsupported");
  });

  // 2026-09-17 review：已识别的危险选项不因同一命令内出现未知选项而失效（存在性规则）。
  it.each([
    ["rm -rfx build", "remove-critical-path"],
    ["rm -rfP build", "remove-critical-path"],
    ["rm -rf -W build", "remove-critical-path"],
    ["rm -rf --preserve-root=all build", "remove-critical-path"],
    ["rm -rf --totally-unknown build", "remove-critical-path"],
    ["rsync -a --delete --info=progress2 src/ dest/", "rsync-delete"],
    ["rsync -a --delete --stats src/ dest/", "rsync-delete"],
    ["rsync -ai --delete src/ dest/", "rsync-delete"],
    ["rsync -a --delete --partial-dir=.rsync-partial src/ dest/", "rsync-delete"],
    ["rsync --unknown-flag --delete src/ dest/", "rsync-delete"],
    ["git push --force --no-verify origin main", "git-push-force"],
    ["git push --force --no-recurse-submodules origin main", "git-push-force"],
    ["git push --force --totally-unknown origin main", "git-push-force"],
    ["git -c core.pager=cat reset --hard HEAD~1", "git-reset-hard"],
    ["git -p reset --hard", "git-reset-hard"],
    ["git --exec-path=/opt/git reset --hard", "git-reset-hard"],
    ["git reset --hard --totally-unknown", "git-reset-hard"],
    ["git checkout -f -t origin/main", "git-discard-tree"],
    ["git checkout -f --guess main", "git-discard-tree"],
    ["git stash clear --totally-unknown", "git-stash-clear"],
    ["git worktree remove --force --totally-unknown path", "git-worktree-force-remove"],
  ])("keeps recognized dangerous options when an unknown option appears: %s", (command, rule) => {
    expect(matchDangerousCommand(command, "posix")).toMatchObject({
      status: "matched",
      ruleId: `safety.bash.${rule}`,
    });
  });

  it.each([
    "rm --totally-unknown build",
    "rsync --unknown-flag src/ dest/",
    "git push --totally-unknown origin main",
    "git reset --totally-unknown",
  ])("still reports unsupported when unknown options leave no reliable hit: %s", (command) => {
    expect(matchDangerousCommand(command, "posix").status).toBe("unsupported");
  });

  it("unknown options in interspersed scans do not consume the next word or enter flags", () => {
    const words = analyzeBashCommand("rm --unknown -rf target").commands[0]!.words.slice(1);
    const parsed = parseOptions(words, optionTable("-r -f"), {
      ordering: "interspersed",
      unknown: "continue",
    });
    expect(parsed.unsupported).toBe(true);
    expect(parsed.flags).toEqual(["-r", "-f"]);
    expect(parsed.operands.map((word) => word.value)).toEqual(["target"]);
  });

  it.each([
    "git reset --hard 2>nul",
    "git reset --hard > out.txt",
    "git reset --hard >> out.txt",
    "git push --force origin main 2>nul",
    "rm -rf build 2>nul",
    "rm -rf build 2> nul",
  ])("CMD trailing redirection target keeps the command matched: %s", (command) => {
    expect(matchDangerousCommand(command, "cmd").status).toBe("matched");
  });
  it.each(["git reset --hard >", "git reset --hard 2>", "git reset --hard > "])(
    "CMD redirection without a target stays unsupported: %s",
    (command) => {
      expect(matchDangerousCommand(command, "cmd").status).toBe("unsupported");
    },
  );

  it.each([
    "rm -rf build",
    '"C:\\tools\\git.exe" reset --hard',
    "echo ok & git stash clear",
    "git clean -fd && echo ok",
  ])("CMD: %s", (command) => {
    expect(matchDangerousCommand(command, "cmd").status).toBe("matched");
  });
  it.each([">rem", "> rem", "2>rem", ">>rem", "<rem", '>"rem"'])(
    "CMD redirection target is not a REM comment: %s",
    (redirection) => {
      expect(matchDangerousCommand(`${redirection} git reset --hard`, "cmd")).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.git-reset-hard",
      });
    },
  );
  it.each([
    "rem git reset --hard",
    ">rem rem git reset --hard",
    ">rem rem ignored & git reset --hard",
  ])("CMD preserves actual REM comments: %s", (command) => {
    expect(matchDangerousCommand(command, "cmd")).toEqual({ status: "notMatched" });
  });
  it.each([
    "rem rm -rf build",
    ":: rm -rf build",
    'echo "rm -rf build"',
    "'rm' -rf build",
    "git reset '--hard'",
    "(echo hi & (rm -rf build))",
  ])("CMD quotes/comments: %s", (command) => {
    expect(matchDangerousCommand(command, "cmd").status).not.toBe("matched");
  });
  it("does not apply Bash grammar to legacy or unsupported shells", () => {
    expect(matchDangerousCommand("rm -rf build", "legacy-shell").status).toBe("unsupported");
  });

  it.each(["posix", "git-bash", "cmd"] as const)(
    "%s keeps rm recursive + force independent of help position and wrappers",
    (dialect) => {
      for (const flags of ["-rf", "-f -R", "--recursive --force"]) {
        for (const query of ["--help", "--version"]) {
          for (const args of [
            `${flags} target ${query}`,
            `${query} ${flags} target`,
            `${flags} ${query}`,
            `${flags} -- ${query}`,
          ]) {
            for (const wrapper of ["", "env A=b ", "time -o timing.txt ", "sudo -u root "]) {
              const command = `${wrapper}rm ${args}`;
              expect(matchDangerousCommand(command, dialect), command).toMatchObject({
                status: "matched",
                ruleId: "safety.bash.remove-critical-path",
              });
            }
          }
        }
      }
      for (const command of ["rm --help", "rm -- -rf"]) {
        expect(matchDangerousCommand(command, dialect), command).toEqual({ status: "notMatched" });
      }
    },
  );

  it("makes operand scanning a caller-owned policy instead of a shared default", () => {
    const words = analyzeBashCommand("rm -rf target --help").commands[0]!.words.slice(1);
    const table = optionTable("-r -f --help");
    const stopped = parseOptions(words, table, {
      ordering: "stop-at-operand",
      unknown: "abort",
    });
    expect(stopped.flags).toEqual(["-r", "-f"]);
    expect(stopped.operands.map((word) => word.value)).toEqual(["target", "--help"]);
    const interspersed = parseOptions(words, table, {
      ordering: "interspersed",
      unknown: "continue",
    });
    expect(interspersed.flags).toEqual(["-r", "-f", "--help"]);
    expect(interspersed.operands.map((word) => word.value)).toEqual(["target"]);
  });

  it("abort policy stops at the first unknown option so wrappers cannot locate the real command", () => {
    const words = analyzeBashCommand("time --unknown rm -rf target").commands[0]!.words.slice(1);
    const parsed = parseOptions(words, optionTable("-p"), {
      ordering: "stop-at-operand",
      unknown: "abort",
    });
    expect(parsed.unsupported).toBe(true);
    expect(parsed.flags).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "native macOS rm treats trailing help/version as deletion operands in an isolated directory",
    async () => {
      // 独立 oracle：不调用 matcher 来决定真实程序应如何解析；所有删除目标都由本测试创建。
      const directory = await mkdtemp(join(tmpdir(), "zcode-guarded-rm-oracle-"));
      try {
        await mkdir(join(directory, "target"));
        await writeFile(join(directory, "target", "keep.txt"), "case-owned");
        await writeFile(join(directory, "--help"), "case-owned");
        await writeFile(join(directory, "--version"), "case-owned");
        await promisify(execFile)("/bin/rm", ["-rf", "target", "--help", "--version"], {
          cwd: directory,
          timeout: 5000,
        });
        for (const operand of ["target", "--help", "--version"]) {
          await expect(access(join(directory, operand))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(matchDangerousCommand("rm -rf target --help --version", "posix").status).toBe(
          "matched",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
