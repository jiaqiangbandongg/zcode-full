import { describe, expect, it } from "vitest";
import {
  applyEmbeddedSearchPrelude,
  buildEmbeddedSearchPreludeContent,
} from "../src/exec/embedded-search-prelude.js";

describe("embedded search bash prelude", () => {
  it("wraps find and grep through the internal CLI backend", () => {
    const command = applyEmbeddedSearchPrelude("grep needle file.txt", {
      kind: "embedded-search",
      backend: {
        kind: "internal-cli",
        command: "zcode",
        args: ["__internal-search"],
      },
    });

    expect(command).toContain("unalias find 2>/dev/null || true");
    expect(command).toContain("unalias grep 2>/dev/null || true");
    expect(command).toContain('command -v zcode >/dev/null 2>&1 || { command find "$@"; return; }');
    expect(command).toContain('command zcode __internal-search find "$@"');
    expect(command).toContain(
      'case "$_zcode_grep_arg" in -*-filter*|-*-pager*|-*-view*|-*-format-open*|-*-config*|---*|-@*|-*-save-config*|-[Zz]*|-[!-]*[Zz]*|--null|--null-data) command grep "$@"; return ;; esac',
    );
    expect(command).toContain('command -v zcode >/dev/null 2>&1 || { command grep "$@"; return; }');
    expect(command).toContain('command zcode __internal-search grep "$@"');
    expect(command).not.toContain("command -v rg");
    expect(command.endsWith("grep needle file.txt")).toBe(true);
  });

  it("can build prelude content without appending the user command", () => {
    const content = buildEmbeddedSearchPreludeContent({
      kind: "embedded-search",
      backend: {
        kind: "internal-cli",
        command: "zcode",
        args: ["__internal-search"],
      },
    });

    expect(content).toContain("unalias find 2>/dev/null || true");
    expect(content).toContain('command zcode __internal-search find "$@"');
    expect(content).not.toContain("grep needle file.txt");
  });

  it("quotes backend command parts for shell functions", () => {
    const command = applyEmbeddedSearchPrelude("find . -name '*.ts'", {
      kind: "embedded-search",
      backend: {
        kind: "internal-cli",
        command: "/tmp/z code",
        args: ["__internal-search", "quoted'value"],
      },
    });

    expect(command).toContain(
      'command -v \'/tmp/z code\' >/dev/null 2>&1 || { command grep "$@"; return; }',
    );
    expect(command).toContain(
      'command \'/tmp/z code\' __internal-search \'quoted\'\\\'\'value\' grep "$@"',
    );
  });

  it("preserves backend env assignments for Electron Node-mode dispatch", () => {
    const command = applyEmbeddedSearchPrelude("find . -name '*.ts'", {
      kind: "embedded-search",
      backend: {
        kind: "internal-cli",
        command: "/Applications/ZCode Helper",
        args: ["/tmp/zcode.cjs", "__internal-search"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    });

    expect(command).toContain(
      'ELECTRON_RUN_AS_NODE=1 command \'/Applications/ZCode Helper\' /tmp/zcode.cjs __internal-search find "$@"',
    );
    expect(command).toContain(
      'ELECTRON_RUN_AS_NODE=1 command \'/Applications/ZCode Helper\' /tmp/zcode.cjs __internal-search grep "$@"',
    );
  });

  it("keeps an argv0-dispatch backend behind the same contract", () => {
    const command = applyEmbeddedSearchPrelude("find . -name '*.ts'", {
      kind: "embedded-search",
      backend: {
        kind: "argv0-dispatch",
        command: "zcode",
      },
    });

    expect(command).toContain('command -v zcode >/dev/null 2>&1 || { command find "$@"; return; }');
    expect(command).toContain('ARGV0=bfs command zcode -S dfs -regextype findutils-default "$@"');
    expect(command).toContain('command -v zcode >/dev/null 2>&1 || { command grep "$@"; return; }');
    expect(command).toContain(
      'ARGV0=ugrep command zcode -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl "$@"',
    );
    expect(command).toContain("if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then");
    expect(command).toContain('ARGV0=rg command zcode "$@"');
  });

  it("executes bundled bfs and ugrep directly and supplies rg only when unavailable", () => {
    const command = applyEmbeddedSearchPrelude("grep -Rni needle .", {
      kind: "embedded-search",
      backend: {
        kind: "native-binaries",
        findCommand: "/opt/zcode/tools/bfs/bfs",
        grepCommand: "/opt/zcode/tools/ugrep/ugrep",
        rgCommand: "/opt/zcode/tools/ripgrep/rg",
      },
    });

    expect(command).toContain(
      'command /opt/zcode/tools/bfs/bfs -S dfs -regextype findutils-default "$@"',
    );
    expect(command).toContain(
      'command /opt/zcode/tools/ugrep/ugrep -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl "$@"',
    );
    expect(command).toContain("if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then");
    expect(command).toContain('command /opt/zcode/tools/ripgrep/rg "$@"');
    expect(command).not.toContain("__internal-search");
    expect(command.endsWith("grep -Rni needle .")).toBe(true);
  });

  it("keeps the rg fallback while find and grep enhancements are disabled", () => {
    const command = applyEmbeddedSearchPrelude("find . && grep needle file.txt && rg needle", {
      kind: "embedded-search",
      backend: {
        kind: "native-binaries",
        findCommand: "/opt/zcode/tools/bfs/bfs",
        grepCommand: "/opt/zcode/tools/ugrep/ugrep",
        rgCommand: "/opt/zcode/tools/ripgrep/rg",
      },
      findAndGrepEnabled: false,
    });

    expect(command).not.toContain("unalias find");
    expect(command).not.toContain("unalias grep");
    expect(command).not.toContain("/opt/zcode/tools/bfs/bfs");
    expect(command).not.toContain("/opt/zcode/tools/ugrep/ugrep");
    expect(command).toContain("command /opt/zcode/tools/ripgrep/rg");
    expect(command.endsWith("find . && grep needle file.txt && rg needle")).toBe(true);
  });

  it("does not advertise a same-name rg fallback when no bundled binary is available", () => {
    const command = applyEmbeddedSearchPrelude("command -v rg || true", {
      kind: "embedded-search",
      backend: {
        kind: "native-binaries",
        findCommand: "bfs",
        grepCommand: "ugrep",
        rgCommand: "rg",
      },
    });

    expect(command).not.toContain("command -v rg) >/dev/null");
    expect(command).not.toContain("rg() {");
  });

  it("converts Windows backend paths for Git Bash shell functions", () => {
    const command = applyEmbeddedSearchPrelude(
      "grep needle file.txt",
      {
        kind: "embedded-search",
        backend: {
          kind: "internal-cli",
          command: "C:\\Program Files\\ZCode\\zcode.exe",
          args: ["C:\\Users\\me\\z-code\\apps\\zcode-cli\\src\\run.ts", "__internal-search"],
        },
      },
      { shellDialect: "git-bash" },
    );

    expect(command).toContain(
      "command -v '/c/Program Files/ZCode/zcode.exe' >/dev/null 2>&1 || { command grep \"$@\"; return; }",
    );
    expect(command).toContain(
      "command '/c/Program Files/ZCode/zcode.exe' /c/Users/me/z-code/apps/zcode-cli/src/run.ts __internal-search grep \"$@\"",
    );
  });

  it("keeps system find and converts bundled ugrep and rg paths for Git Bash", () => {
    const command = applyEmbeddedSearchPrelude(
      "find . -name '*.ts'",
      {
        kind: "embedded-search",
        backend: {
          kind: "native-binaries",
          findCommand: "C:\\Program Files\\ZCode\\tools\\bfs\\bfs.exe",
          grepCommand: "C:\\Program Files\\ZCode\\tools\\ugrep\\ugrep.exe",
          rgCommand: "C:\\Program Files\\ZCode\\tools\\ripgrep\\rg.exe",
        },
      },
      { shellDialect: "git-bash" },
    );

    expect(command).not.toContain("unalias find");
    expect(command).not.toContain("find() {");
    expect(command).toContain(
      "command '/c/Program Files/ZCode/tools/ugrep/ugrep.exe' -G --ignore-files --hidden -I",
    );
    expect(command).toContain("command '/c/Program Files/ZCode/tools/ripgrep/rg.exe' \"$@\"");
  });

  it("does not inject POSIX shell functions for CMD or legacy shell fallback", () => {
    const prelude = {
      kind: "embedded-search" as const,
      backend: {
        kind: "internal-cli" as const,
        command: "zcode",
        args: ["__internal-search"],
      },
    };

    expect(
      applyEmbeddedSearchPrelude("grep needle file.txt", prelude, { shellDialect: "cmd" }),
    ).toBe("grep needle file.txt");
    expect(
      applyEmbeddedSearchPrelude("grep needle file.txt", prelude, {
        shellDialect: "legacy-shell",
      }),
    ).toBe("grep needle file.txt");
  });

  it("leaves shell commands unchanged without a prelude", () => {
    expect(applyEmbeddedSearchPrelude("echo ok")).toBe("echo ok");
  });
});
