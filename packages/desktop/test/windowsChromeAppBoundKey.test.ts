import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEncodedPowerShellArgs } from "../scripts/powershell-command.mjs";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import {
  createSanitizedHelperEnvironment,
  readWindowsChromeAppBoundKey,
  WindowsChromeAppBoundImportError,
} from "../src/main/windowsChromeAppBoundKey.js";

const logger = { info: vi.fn(), warn: vi.fn() };
const execFileAsync = promisify(execFile);
let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-app-bound-test-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function createFixture(): Promise<{ helperPath: string; userDataDir: string }> {
  const helperRoot = join(tempRoot, "browser-import");
  const helperPath = join(helperRoot, "zcode-browser-import-helper.exe");
  const userDataDir = join(tempRoot, "User Data");
  await mkdir(helperRoot, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await writeFile(helperPath, "synthetic helper fixture");
  await writeFile(
    join(userDataDir, "Local State"),
    JSON.stringify({
      os_crypt: {
        app_bound_encrypted_key: Buffer.concat([Buffer.from("APPB"), Buffer.alloc(64, 3)]).toString(
          "base64",
        ),
      },
    }),
  );
  return { helperPath, userDataDir };
}

function decodeEncodedPowerShellCommand(args: string[]): string {
  expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  expect(args).toHaveLength(5);
  return Buffer.from(args[4]!, "base64").toString("utf16le");
}

describe("windowsChromeAppBoundKey", () => {
  it("净化环境固定 EXE 扩展并允许 PowerShell 启动原生 helper", async () => {
    const env = createSanitizedHelperEnvironment({
      ...process.env,
      PATHEXT: ".CMD;.VBS",
    });
    expect(env.PATHEXT).toBe(".EXE");

    if (process.platform !== "win32") return;
    const powershellPath = join(
      process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const commandPath = process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
    const marker = "zcode-native-helper-ok";
    const { stdout } = await execFileAsync(
      powershellPath,
      createEncodedPowerShellArgs(
        "$response=& $zcodeArg0 /d /c $zcodeArg1;[Console]::Out.Write(($response -join ''))",
        [commandPath, `echo ${marker}`],
      ),
      { env, windowsHide: true },
    );

    expect(stdout.trim()).toBe(marker);
  });

  it("原生服务直接校验原始 broker 身份并可强制停止残留服务", async () => {
    const [source, buildSource] = await Promise.all([
      readFile(
        join(import.meta.dirname, "../native/windows-browser-import-helper/Program.cs"),
        "utf8",
      ),
      readFile(
        join(import.meta.dirname, "../scripts/build-windows-browser-import-helper.mjs"),
        "utf8",
      ),
    ]);

    expect(source).toContain('RequireArgument(serviceArguments, "--broker-pid")');
    expect(source).toContain("ConnectPipeClient(systemPipeName, servicePid, false)");
    expect(source).toMatch(/ServiceControlHandler[\s\S]*serviceStopEvent\.Set\(\)/);
    expect(source).toContain("TerminateProcess(serviceProcess");
    expect(source).toContain("MonitorBrokerAndDeadline(brokerPipe, parentPid");
    expect(source).toContain("MonitorHostAndDeadline(hostPid");
    expect(source).toContain("DateTime.UtcNow >= deadline");
    expect(source).toContain("brokerPipe.Dispose()");
    expect(source).toContain('WriteError("broker_initialization_failed")');
    expect(source).toContain('WriteError("controller_handshake_failed")');
    expect(source).toContain('WriteError("service_channel_failed")');
    expect(source).toContain(
      "VerifyPipeClient(pipe.SafePipeHandle, GetSelfPath(), elevated.Id, false)",
    );
    expect(source).toContain("VerifyProcessImagePathHandle(brokerProcess, GetSelfPath())");
    expect(source).toContain("VerifyPipeClient(pipe.SafePipeHandle, GetSelfPath(), brokerPid)");
    expect(buildSource).toContain('targetArch === "arm64" && !process.env.ZCODE_CSC_PATH');
    expect(buildSource).toContain('`/platform:${targetArch}`');
  });

  it("服务端命名管道以异步模式创建以支持有界等待", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../native/windows-browser-import-helper/Program.cs"),
      "utf8",
    );
    const serverStart = source.indexOf("private static NamedPipeServerStream CreatePipeServer");
    const clientStart = source.indexOf("private static NamedPipeClientStream ConnectPipeClient");

    expect(serverStart).toBeGreaterThanOrEqual(0);
    expect(clientStart).toBeGreaterThan(serverStart);
    const serverSource = source.slice(serverStart, clientStart);
    expect(serverSource).toContain("PipeOptions.Asynchronous");
    expect(serverSource).not.toContain("PipeOptions.None");
    expect(source).toContain(
      '".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Impersonation',
    );
    expect(source).toContain("pipe.BeginWaitForConnection(null, null)");
  });

  it("只通过 stdin/stdout 协议传递 APPB 密文并返回 32 字节密钥", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn(async (_path: string, args: string[], input?: string) => {
      if (args[0] === "--version") {
        return {
          exitCode: 0,
          stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
        };
      }
      expect(args).toEqual(["--broker", "--parent-pid", String(process.pid)]);
      expect(input).toMatch(/^ZCODE_BROWSER_IMPORT_V1\t/);
      expect(input).not.toContain("chrome.exe\t");
      return {
        exitCode: 0,
        stdout: `ZCODE_BROWSER_IMPORT_V1\tOK\t${Buffer.alloc(32, 7).toString("base64")}`,
      };
    });

    const key = await readWindowsChromeAppBoundKey({
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      helperPath: fixture.helperPath,
      isPackaged: false,
      logger,
      processArch: "x64",
      runHelper,
      userDataDir: fixture.userDataDir,
    });

    expect(key).toEqual(Buffer.alloc(32, 7));
    expect(runHelper).toHaveBeenCalledTimes(2);
  });

  it("把用户取消 UAC 映射为稳定错误码", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
          }
        : { exitCode: 0, stdout: "ZCODE_BROWSER_IMPORT_V1\tERR\televation_cancelled" },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: false,
        logger,
        processArch: "x64",
        runHelper,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_elevation_cancelled" });
  });

  it("只把白名单 helper 失败原因写入本地日志", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
          }
        : { exitCode: 0, stdout: "ZCODE_BROWSER_IMPORT_V1\tERR\tcng_failed" },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: false,
        logger,
        processArch: "x64",
        runHelper,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_app_bound_decryption_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Windows Chrome App-Bound helper 返回失败",
      { reason: "cng_failed" },
    );
  });

  it("把原生服务通道阶段失败原因写入本地日志", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
          }
        : { exitCode: 0, stdout: "ZCODE_BROWSER_IMPORT_V1\tERR\tservice_channel_failed" },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: false,
        logger,
        processArch: "x64",
        runHelper,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_app_bound_decryption_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Windows Chrome App-Bound helper 返回失败",
      { reason: "service_channel_failed" },
    );
  });

  it("未知 helper 响应只记录 invalid_response 而不记录原文", async () => {
    const fixture = await createFixture();
    const secretMarker = "secret-path-or-key-material";
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
          }
        : {
            exitCode: 0,
            stdout: `ZCODE_BROWSER_IMPORT_V1\tERR\t${secretMarker}`,
          },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: false,
        logger,
        processArch: "x64",
        runHelper,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_app_bound_decryption_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Windows Chrome App-Bound helper 返回失败",
      { reason: "invalid_response" },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secretMarker);
  });

  it("畸形 helper 响应只记录 invalid_response 而不记录原文", async () => {
    const fixture = await createFixture();
    const rawResponse = "raw-helper-output-must-not-leak";
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      args[0] === "--version"
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
          }
        : { exitCode: 1, stdout: rawResponse },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: false,
        logger,
        processArch: "x64",
        runHelper,
        userDataDir: fixture.userDataDir,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_app_bound_decryption_failed" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-data] Windows Chrome App-Bound helper 返回失败",
      { reason: "invalid_response" },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(rawResponse);
  });

  it("发布态签名不匹配时在启动 helper 前 fail closed", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn();
    const verifySignature = vi.fn(async () => false);

    await expect(
      readWindowsChromeAppBoundKey({
        appExecutablePath: join(tempRoot, "ZCode.exe"),
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: true,
        logger,
        processArch: "x64",
        resourcesPath: tempRoot,
        runHelper,
        userDataDir: fixture.userDataDir,
        verifySignature,
      }),
    ).rejects.toBeInstanceOf(WindowsChromeAppBoundImportError);
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("发布态签名校验绑定的文件摘要不一致时 fail closed", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn();

    await expect(
      readWindowsChromeAppBoundKey({
        appExecutablePath: join(tempRoot, "ZCode.exe"),
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        helperPath: fixture.helperPath,
        isPackaged: true,
        logger,
        processArch: "x64",
        resourcesPath: tempRoot,
        runHelper,
        userDataDir: fixture.userDataDir,
        verifySignature: vi.fn(async () => "different-file-digest"),
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_helper_verification_failed" });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("发布态 helper 在校验后被替换时不发送解密请求", async () => {
    const fixture = await createFixture();
    const verifySignature = vi.fn(async () => true);
    const runHelper = vi.fn(async (executablePath: string, args: string[]) => {
      const command = decodeEncodedPowerShellCommand(args);
      if (command.includes("--version")) {
        return {
          exitCode: 0,
          stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest",
        };
      }
      expect(executablePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(command).toContain("FileShare]::Read");
      await writeFile(fixture.helperPath, "replaced after verification");
      return {
        exitCode: 23,
        stdout: "ZCODE_BROWSER_IMPORT_V1\tERR\thelper_verification_failed",
      };
    });

    await expect(
      readWindowsChromeAppBoundKey({
        appExecutablePath: join(tempRoot, "ZCode.exe"),
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        expectedAppVersion: "3.4.0",
        expectedBuildCommit: "test",
        helperPath: fixture.helperPath,
        isPackaged: true,
        logger,
        processArch: "x64",
        resourcesPath: tempRoot,
        runHelper,
        trustedPowerShellPath:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        userDataDir: fixture.userDataDir,
        verifySignature,
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_helper_verification_failed" });
  });

  it("发布态 helper 构建版本与应用不一致时 fail closed", async () => {
    const fixture = await createFixture();
    const runHelper = vi.fn(async (_path: string, args: string[]) =>
      decodeEncodedPowerShellCommand(args).includes("--version")
        ? {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\tbuild-a",
          }
        : {
            exitCode: 0,
            stdout: `ZCODE_BROWSER_IMPORT_V1\tOK\t${Buffer.alloc(32, 7).toString("base64")}`,
          },
    );

    await expect(
      readWindowsChromeAppBoundKey({
        appExecutablePath: join(tempRoot, "ZCode.exe"),
        chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        expectedAppVersion: "3.4.0",
        expectedBuildCommit: "build-b",
        helperPath: fixture.helperPath,
        isPackaged: true,
        logger,
        processArch: "x64",
        resourcesPath: tempRoot,
        runHelper,
        trustedPowerShellPath:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        userDataDir: fixture.userDataDir,
        verifySignature: vi.fn(async () => true),
      }),
    ).rejects.toMatchObject({ code: "chrome_cookie_helper_verification_failed" });
    expect(runHelper).toHaveBeenCalledTimes(1);
  });

  it("发布态由可信 PowerShell 持有已验证 helper 文件锁后再启动 broker", async () => {
    const fixture = await createFixture();
    const trustedPowerShellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const runHelper = vi.fn(
      async (
        executablePath: string,
        args: string[],
        _input?: string,
        beforeInput?: () => Promise<void>,
      ) => {
        const command = decodeEncodedPowerShellCommand(args);
        if (command.includes("--version")) {
          expect(executablePath).toBe(trustedPowerShellPath);
          expect(command).toContain("FileShare]::Read");
          return {
            exitCode: 0,
            stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\tbuild-a",
          };
        }
        expect(executablePath).toBe(trustedPowerShellPath);
        expect(command).toContain("FileShare]::Read");
        expect(command).not.toContain(fixture.helperPath);
        expect(command).toContain(Buffer.from(fixture.helperPath, "utf8").toString("base64"));
        await beforeInput?.();
        return {
          exitCode: 0,
          stdout: `ZCODE_BROWSER_IMPORT_V1\tOK\t${Buffer.alloc(32, 7).toString("base64")}`,
        };
      },
    );

    const key = await readWindowsChromeAppBoundKey({
      appExecutablePath: join(tempRoot, "ZCode.exe"),
      chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      expectedAppVersion: "3.4.0",
      expectedBuildCommit: "build-a",
      helperPath: fixture.helperPath,
      isPackaged: true,
      logger,
      processArch: "x64",
      resourcesPath: tempRoot,
      runHelper,
      trustedPowerShellPath,
      userDataDir: fixture.userDataDir,
      verifySignature: vi.fn(async () => true),
    });

    expect(key).toEqual(Buffer.alloc(32, 7));
  });
});
