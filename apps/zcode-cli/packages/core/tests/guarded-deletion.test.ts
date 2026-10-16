import { describe, expect, it } from "vitest";
import { matchDangerousCommand } from "../src/tool/handlers/guarded/command.js";
import { literalPosixWord } from "../src/tool/handlers/guarded/word.js";
import { analyzeCmdCommand } from "../src/tool/handlers/guarded/cmd.js";

describe("Guarded deletion catalog", () => {
  it.each(["rm first --help", "rm first --version", "rm first -f", "rm first --"])(
    "counts BSD rm trailing option-shaped filenames: %s",
    (command) => {
      expect(matchDangerousCommand(command, "posix")).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.remove-critical-path",
      });
    },
  );

  it.each(["posix", "git-bash"] as const)("%s recursive and syntactically batch rm", (dialect) => {
    for (const command of [
      "rm -r dir",
      "rm -R dir",
      "rm --recursive dir",
      "rm -ri dir",
      "rm -r --help",
      "rm a b",
      'rm "one file" "two files"',
      "rm -- -r -f",
      "rm *.log",
      "rm file?.txt",
      "rm [ab].txt",
      'rm "prefix"*.log',
      "rm -f *.log",
      "rm -r --unknown dir",
      "env A=b rm -r dir",
      "time -o timing.txt rm a b",
      "sudo -u root rm *.log",
      "echo ready; rm a b",
      "true && rm -r dir",
      "false || rm *.log",
      "rm a b | cat",
      "rm a b > output",
      "rm a b # keep comment",
    ])
      expect(matchDangerousCommand(command, dialect), command).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.remove-critical-path",
      });
    for (const command of [
      "rm one",
      "rm -f one",
      'rm "one file"',
      "rm -- -r",
      "rm --help",
      'rm "*.log"',
      "rm '*.log'",
      "rm \\*.log",
      "rm file\\?.txt",
      "rm \\[ab].txt",
      "rm $TARGET",
      'rm "$TARGET"',
      "rm {a,b}",
      "rm $(echo target)",
      "rm $(echo *)",
      "rm ${TARGET:-*}",
      'echo "rm a b"',
      "echo ok # rm a b",
      "echo ok > rm",
      "rmdir empty",
      "rmdir /s folder",
      "del file",
      "xargs rm -r",
      "npx rimraf dir",
      "sh -c 'rm -r dir'",
    ])
      expect(matchDangerousCommand(command, dialect).status, command).not.toBe("matched");
  });

  it.each(["-d", "-x", "-d -x"])("BSD find %s keeps the starting-path phase", (flags) => {
    for (const command of [
      `find ${flags} . -type f -delete`,
      `find ${flags} "space dir" another -delete`,
      `time -o timing.txt find ${flags} . -delete`,
    ])
      expect(matchDangerousCommand(command, "posix"), command).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.find-delete",
      });
    for (const command of [
      `find ${flags} . -type f -print`,
      `find ${flags} . -name '-delete'`,
      `find ${flags} . -exec echo -delete \\;`,
    ])
      expect(matchDangerousCommand(command, "posix"), command).toEqual({ status: "notMatched" });
    expect(matchDangerousCommand(`find ${flags} . -unknown -delete`, "posix")).toEqual({
      status: "unsupported",
    });
  });

  it.each(["posix", "git-bash"] as const)("%s find action arity", (dialect) => {
    for (const command of [
      "find . -delete",
      "find . -type f -name '*.log' -delete",
      "find . \\( -name a -o -name b \\) -delete",
      "find . -false -a -delete",
      "find . -exec echo {} \\; -delete",
      "find . -execdir echo {} + -delete",
      "find . -ok echo {} \\; -delete",
      "find . -okdir echo {} \\; -delete",
      "find -L . -maxdepth 2 -mtime +1 -delete",
      "find . -delete -unknown value",
      "time -o file find . -delete",
      "find . -unknown value; rm -r dir",
    ])
      expect(matchDangerousCommand(command, dialect).status, command).toBe("matched");
    for (const command of [
      "find . -name '-delete'",
      "find . -path -delete",
      "find . -printf '-delete'",
      "find . -fprintf out '-delete'",
      "find . -fprint -delete",
      "find . -exec echo -delete \\;",
      "find . -exec rm -rf {} +",
      "find . -okdir echo -delete \\;",
      "find . -print",
      "find . -name '*.log'",
    ])
      expect(matchDangerousCommand(command, dialect).status, command).not.toBe("matched");
    for (const command of ["find . -unknown -delete", "find . -name", "find . -exec echo -delete"])
      expect(matchDangerousCommand(command, dialect), command).toEqual({ status: "unsupported" });
  });

  it.each([
    ["rd /s folder", "cmd-remove-tree"],
    ['RMDIR /S /Q "space dir"', "cmd-remove-tree"],
    ["rmdir folder /s", "cmd-remove-tree"],
    ["rd /s folder /?", "cmd-remove-tree"],
    ["rd /s/q folder", "cmd-remove-tree"],
    ["rmdir /Q/S folder", "cmd-remove-tree"],
    ["rd target/s/q", "cmd-remove-tree"],
    ["rd/s/q target", "cmd-remove-tree"],
    ['RMDIR/Q/S "space dir"', "cmd-remove-tree"],
    ["rd target^/s/q", "cmd-remove-tree"],
    ["del/q target\\one.txt", "cmd-delete-files"],
    ["erase/P file", "cmd-delete-files"],
    [">rem rd/s/q target 2>nul", "cmd-remove-tree"],
    ["echo ready && rd target/s/q | more", "cmd-remove-tree"],
    ["del file", "cmd-delete-files"],
    ['ERASE /P "space dir"', "cmd-delete-files"],
    ["del /s /q *.txt", "cmd-delete-files"],
    ["erase dir /A:-R", "cmd-delete-files"],
    ["del file /?", "cmd-delete-files"],
    [">rem rd /s dir", "cmd-remove-tree"],
    ["echo ready & del file", "cmd-delete-files"],
    ["echo ready && rd /s dir", "cmd-remove-tree"],
    ["del file 2>nul", "cmd-delete-files"],
    ["rd /s dir | more", "cmd-remove-tree"],
  ])("CMD deletion: %s", (command, rule) => {
    expect(matchDangerousCommand(command, "cmd")).toMatchObject({
      status: "matched",
      ruleId: `safety.bash.${rule}`,
    });
  });
  it.each([
    "rd dir",
    "rmdir /?",
    "rd /?",
    "del",
    "del /q /s",
    "del /?",
    "erase /?",
    "rem del file",
    'echo "rd /s dir"',
    "find file -delete",
    'rd "target/s/q"',
    "rd target > output/s/q",
    "rd/?",
    "del/q",
    "del/?",
    "echo rd/s/q target",
    "rem rd/s/q target",
  ])("CMD non-deletion: %s", (command) => {
    expect(matchDangerousCommand(command, "cmd").status).not.toBe("matched");
  });

  it("keeps CMD builtin switch splitting local and source positions exact", () => {
    const command = "echo ready & rd/s/q target";
    expect(matchDangerousCommand(command, "cmd")).toMatchObject({
      start: command.indexOf("rd/"),
      end: command.length,
    });
    for (const source of ["echo target/s/q", "C:/bin/tool.exe target/s/q", "git -C /s status"])
      expect(analyzeCmdCommand(source).commands[0]?.map((word) => word.value)).toEqual(
        source.split(" "),
      );
    expect(analyzeCmdCommand('rd "target/s/q"').commands[0]?.map((word) => word.value)).toEqual([
      "rd",
      "target/s/q",
    ]);
  });

  it("recognizes Git Bash Robocopy drive paths without weakening switch arity", () => {
    for (const command of [
      "robocopy /c/src /c/dst /MIR",
      "env MSYS2_ARG_CONV_EXCL=/MIR robocopy /c/src /c/dst /MIR",
      'robocopy "/c/space src" "/d/space dst" /PURGE',
      "robocopy /MIR /c/src /d/dst /R:0 /W:0",
    ])
      expect(matchDangerousCommand(command, "git-bash"), command).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.robocopy-delete",
      });
    for (const command of [
      "robocopy /c/src /c/dst /MIR /L",
      "robocopy /c/src /c/dst /PURGE /XD /c/excluded /L",
      "robocopy /c/src /c/dst /LOG:/MIR",
      "robocopy /c/src /MIR",
    ])
      expect(matchDangerousCommand(command, "git-bash").status, command).not.toBe("matched");
    expect(matchDangerousCommand("robocopy /unknown /c/src /c/dst /MIR", "git-bash")).toEqual({
      status: "unsupported",
    });
    expect(matchDangerousCommand("robocopy /JOB:job /c/src /c/dst /MIR", "git-bash")).toEqual({
      status: "unsupported",
    });
    expect(matchDangerousCommand("robocopy /c/src /c/dst /MIR", "cmd").status).toBe("unsupported");
  });

  it.each(["cmd", "git-bash"] as const)("%s Robocopy option ownership", (dialect) => {
    for (const command of [
      "robocopy src dst /MIR",
      "robocopy /MIR src dst",
      "robocopy src /PURGE dst",
      "ROBOCOPY.EXE src dst /purge",
      'robocopy "space src" "space dst" /E /PURGE',
      "robocopy src dst /MIR /LOG:out",
      "robocopy src dst /MIR /unknown /L",
      "robocopy src dst /MIR /JOB:job",
      "robocopy src dst /XF /MIR",
    ])
      expect(matchDangerousCommand(command, dialect), command).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.robocopy-delete",
      });
    for (const command of [
      "robocopy src dst /E",
      "robocopy src dst /MIR /L",
      "robocopy src dst /l /PURGE",
      "robocopy src dst /LOG:/MIR",
      "robocopy src dst /MIR /XF /L",
      "robocopy src dst /MIR /XD /L",
      "robocopy /MIR dst",
      "robocopy src /PURGE",
      "robocopy /?",
      "robocopy src dst /JOB:job",
    ])
      expect(matchDangerousCommand(command, dialect).status, command).not.toBe("matched");
    expect(matchDangerousCommand("robocopy src dst /unknown /L /MIR", dialect).status).toBe(
      "unsupported",
    );
  });
  it("does not treat POSIX slash paths as Windows switches", () => {
    expect(matchDangerousCommand("robocopy src dst /MIR", "posix").status).toBe("notMatched");
    expect(matchDangerousCommand("rm /s", "posix").status).toBe("notMatched");
  });

  it.each(["posix", "git-bash", "cmd"] as const)("%s Git clean effective force", (dialect) => {
    for (const command of [
      "git clean -f",
      "git clean -fx",
      "git clean -fX",
      "git clean --force",
      "git clean -nf --no-dry-run",
      "git clean -f -e --dry-run",
    ])
      expect(matchDangerousCommand(command, dialect), command).toMatchObject({
        status: "matched",
        ruleId: "safety.bash.git-clean-force",
      });
    for (const command of [
      "git clean",
      "git clean -fn",
      "git clean -f --dry-run",
      "git clean -f --help",
      "git clean -n --no-dry-run -f -n",
    ])
      expect(matchDangerousCommand(command, dialect).status, command).not.toBe("matched");
  });

  it("keeps literal, dynamic and unquoted glob as separate word facts", () => {
    for (const [source, dynamic, hasUnquotedGlob] of [
      ["*.log", true, true],
      ['"*.log"', false, false],
      ["\\*.log", false, false],
      ["$TARGET", true, false],
      ["{a,b}", true, false],
      ["file?.txt", true, true],
    ] as const)
      expect(literalPosixWord(source, 3, 3 + source.length)).toMatchObject({
        dynamic,
        hasUnquotedGlob,
        start: 3,
        end: 3 + source.length,
      });
  });
});
