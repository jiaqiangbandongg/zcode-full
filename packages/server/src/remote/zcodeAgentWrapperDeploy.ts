import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";

export function isWslBackend(backend: IRemoteBackend): boolean {
  return (backend as { kind?: string }).kind === "wsl";
}

export async function deployRemoteAgentWrapper(params: {
  backend: IRemoteBackend;
  content: string;
  remoteWrapperPath: string;
}): Promise<void> {
  const remoteWrapperTempPath = `${params.remoteWrapperPath}.new`;
  if (isWslBackend(params.backend)) {
    const localTempPath = join(tmpdir(), `zcode-agent-wrapper-${process.pid}-${Date.now()}.sh`);
    try {
      // 历史原因：WSLBackend 曾以 `wsl.exe -- bash -lc <command>` 启动，默认 shell 会让多行
      // shell 参数里的 `$HOME`、`$runtime_root`、`$@` 提前展开，生成 `exec "/node" ...` 的坏 wrapper，
      // 因此 WSL 改为按字节上传临时文件。该根因已由 buildWslArgs 改用 `--exec` 修复（R3-ISSUE-024）；
      // 上传路径暂时保留，待 Windows 实机验证关闭该 issue 后再评估是否并回 SSH 的远端 shell 写入路径。
      await writeFile(localTempPath, params.content, "utf8");
      await params.backend.upload(localTempPath, remoteWrapperTempPath);
      const replaceStream = await params.backend.exec(
        buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteWrapperPath),
      );
      await waitForClose(replaceStream);
    } finally {
      await rm(localTempPath, { force: true });
    }
    return;
  }

  const stream = await params.backend.exec(
    [
      buildWriteLiteralFileCommand(remoteWrapperTempPath, params.content),
      buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteWrapperPath),
    ].join(" && "),
  );
  await waitForClose(stream);
}
