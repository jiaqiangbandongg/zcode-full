# Bash Windows Shell Resolve Real-World 执行脚本

请严格按下面清单使用 `Bash` tool 发起 tool call。这个脚本只用于制造 Windows 下 Bash shell resolve 轨迹。

## 总规则

1. 只执行，不验证，不解释，不对比，不修复。
2. 每个 case 使用一个独立的 `Bash` tool call，不要合并多个 case。
3. 必须严格串行执行：按 W0、W1、W2、W3 ... 的顺序逐个执行，上一条 Bash tool result 返回后再发下一条 Bash tool call。
4. 除非 case 单独写了 tool 参数，否则只传 `command` 和 `description`。
5. 不要使用 `Read` / `Grep` / `Glob` / `Edit` / `Write` / `Agent` / `WebSearch` 等其他工具。
6. 不要创建或修改测试文件；本脚本只允许临时切换 cwd，不写入工作区文件。
7. 即使命令返回非 0，也继续执行后续 Bash tool call。
8. 执行完成后，只回复一行：`DONE`。

## W0. Platform probe

```json
{
  "description": "Print platform details before Windows shell resolve cases",
  "command": "printf 'W0 shell0=%s\\n' \"$0\"\nprintf 'W0 bash=%s\\n' \"${BASH_VERSION:-}\"\nprintf 'W0 shell_env=%s\\n' \"${SHELL:-}\"\nif command -v uname >/dev/null 2>&1; then uname -a | sed 's/^/W0 uname=/'; else printf 'W0 uname=missing\\n'; fi\nif command -v pwd >/dev/null 2>&1; then pwd -W 2>/dev/null | sed 's/^/W0 pwd_windows=/'; fi"
}
```

## W1. Shell identity

```json
{
  "description": "Print Windows Bash shell identity",
  "command": "printf 'W1 shell0=%s\\n' \"$0\"\nprintf 'W1 bash=%s\\n' \"${BASH_VERSION:-}\"\nprintf 'W1 zsh=%s\\n' \"${ZSH_VERSION:-}\"\nprintf 'W1 shell_env=%s\\n' \"${SHELL:-}\"\nprintf 'W1 git_editor=%s\\n' \"${GIT_EDITOR:-}\"\nprintf 'W1 pwd_posix=%s\\n' \"$(pwd -P)\"\nif command -v uname >/dev/null 2>&1; then uname -a | sed 's/^/W1 uname=/'; fi\nif command -v pwd >/dev/null 2>&1; then pwd -W 2>/dev/null | sed 's/^/W1 pwd_windows=/'; fi"
}
```

## W2. Bash-only syntax

```json
{
  "description": "Run Bash-only syntax on resolved Windows shell",
  "command": "arr=(win bash resolver)\nprintf 'W2 array=%s\\n' \"${arr[1]}-${arr[2]}\"\nif [[ \"windows-bash-2026\" =~ ^windows-bash-[0-9]+$ ]]; then printf 'W2 regex=match\\n'; else printf 'W2 regex=no-match\\n'; fi\ncat <(printf 'W2 process-substitution-ok\\n')"
}
```

## W3. Pipeline status

```json
{
  "description": "Print Bash pipeline status",
  "command": "false | true\nprintf 'W3 pipe=%s %s\\n' \"${PIPESTATUS[0]}\" \"${PIPESTATUS[1]}\""
}
```

## W4. Login shell and environment overlay

```json
{
  "description": "Check login shell and Git editor environment",
  "command": "shopt -q login_shell\nprintf 'W4 login_rc=%s\\n' \"$?\"\nprintf 'W4 shell_env=%s\\n' \"${SHELL:-}\"\nprintf 'W4 git_editor=%s\\n' \"${GIT_EDITOR:-}\""
}
```

## W5. Move cwd to an existing in-workspace directory

```json
{
  "description": "Change cwd to an existing workspace subdirectory",
  "command": "START=\"$(pwd -P)\"\nif [ -d \"$START/apps/zcode-cli\" ]; then\n  NEXT=\"$START/apps/zcode-cli\"\nelif [ -d \"$START/packages\" ]; then\n  NEXT=\"$START/packages\"\nelif [ -d \"$START/src\" ]; then\n  NEXT=\"$START/src\"\nelse\n  NEXT=\"$START\"\nfi\ncd \"$NEXT\"\nprintf 'W5 start=%s\\n' \"$START\"\nprintf 'W5 next=%s\\n' \"$NEXT\"\nprintf 'W5 pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W5 pwd_windows=/'"
}
```

## W6. Confirm in-workspace cwd persisted

```json
{
  "description": "Print cwd after in-workspace cwd capture",
  "command": "printf 'W6 pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W6 pwd_windows=/'"
}
```

## W7. Change cwd outside workspace

```json
{
  "description": "Change cwd outside workspace through Git Bash temp path",
  "command": "cd /tmp\nprintf 'W7 pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W7 pwd_windows=/'"
}
```

## W8. Print cwd immediately after outside reset

```json
{
  "description": "Print cwd immediately after outside cwd reset",
  "command": "printf 'W8 after_reset_pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W8 after_reset_pwd_windows=/'"
}
```

## W9. Recheck cwd after outside reset

```json
{
  "description": "Recheck cwd in a second command after outside cwd reset",
  "command": "printf 'W9 recheck_pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W9 recheck_pwd_windows=/'"
}
```

## W10. Windows path conversion helpers available in shell

```json
{
  "description": "Print Windows path conversion from Git Bash",
  "command": "printf 'W10 comspec=%s\\n' \"${COMSPEC:-${ComSpec:-}}\"\nif command -v cygpath >/dev/null 2>&1; then\n  cygpath -u \"${COMSPEC:-${ComSpec:-C:\\\\Windows\\\\System32\\\\cmd.exe}}\" | sed 's/^/W10 comspec_posix=/'\n  cygpath -w \"$(pwd -P)\" | sed 's/^/W10 pwd_windows=/'\nelse\n  printf 'W10 cygpath=missing\\n'\nfi"
}
```

## W11. Background command uses same Bash shell profile

Tool 参数：`run_in_background: true`

```json
{
  "description": "Run background Bash syntax on Windows shell resolver",
  "run_in_background": true,
  "command": "arr=(background bash)\nprintf 'W11 array=%s\\n' \"${arr[1]}\"\ncat <(printf 'W11 process-substitution-ok\\n')\nprintf 'W11 stderr\\n' >&2"
}
```

## W12. Final shell state

```json
{
  "description": "Print final Windows Bash shell state",
  "command": "printf 'W12 shell0=%s\\n' \"$0\"\nprintf 'W12 bash=%s\\n' \"${BASH_VERSION:-}\"\nprintf 'W12 shell_env=%s\\n' \"${SHELL:-}\"\nprintf 'W12 pwd=%s\\n' \"$(pwd -P)\"\npwd -W 2>/dev/null | sed 's/^/W12 pwd_windows=/'"
}
```
