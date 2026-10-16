import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

const BASH_PREFIX_PERMISSION_SPEC =
  "conversation-session-v4-bash-command-prefix-permission.test.ts";
const CASE_RUNTIME_DIR = "conversation-session-v4-bash-command-prefix-permission";

const PNPM_SHIM = `#!/bin/sh
case " $* " in
  *" run lint "*)
    printf "%s\\n" "lint-ok"
    ;;
  *" run test "*)
    printf "%s\\n" "test-ok"
    ;;
  *)
    printf "%s\\n" "unsupported deterministic pnpm fixture: $*" >&2
    exit 64
    ;;
esac
`;

export async function installBashPrefixPermissionPnpmShim(params: {
  environment: NodeJS.ProcessEnv;
  homeDir: string;
  specs: readonly string[];
}): Promise<string | undefined> {
  if (!params.specs.some((spec) => spec.includes(BASH_PREFIX_PERMISSION_SPEC))) {
    return undefined;
  }

  const shimDirectory = join(params.homeDir, "ZCodeProject", ".zcode-e2e", CASE_RUNTIME_DIR, "bin");
  const shimPath = join(shimDirectory, "pnpm");
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(shimPath, PNPM_SHIM, { encoding: "utf8", mode: 0o755 });
  if (process.platform !== "win32") {
    await chmod(shimPath, 0o755);
  }

  // Bug 根因：BPR 只验证 pnpm script 的权限 prefix，却调用 runner 上的真实 pnpm；
  // 全量 E2E 下外部 store/启动状态偶发卡住子进程。只给本 case 的 Electron/Host/Agent
  // 继承确定性 shim，命令文本和 Bash/prefix 执行链保持不变，其他 spec 的 PATH 不受影响。
  // Windows 通常保留 `Path` 的原始大小写；另写 `PATH` 会让 spawn 收到两个同名变量，
  // Node 在序列化环境时可能选中未注入 shim 的旧值，因此必须原位更新已有 key。
  const pathKey =
    Object.keys(params.environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = params.environment[pathKey] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);
  params.environment[pathKey] = [
    shimDirectory,
    ...entries.filter((entry) => entry !== shimDirectory),
  ].join(delimiter);
  return shimPath;
}
