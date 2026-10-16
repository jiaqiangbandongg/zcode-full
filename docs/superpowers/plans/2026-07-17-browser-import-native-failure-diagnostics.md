# Browser Import Native Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a safe native App-Bound helper failure reason in desktop local logs while keeping UI, IPC, and public error behavior unchanged, then use that signal to identify the real Windows import failure.

**Architecture:** The existing helper protocol already returns stable `ERR` reason tokens. The desktop main process will classify those tokens against an exact allowlist at the protocol boundary, log only the classified reason, and continue throwing the existing public `chrome_cookie_app_bound_decryption_failed` error. A one-shot Windows smoke probe will consume the installed signed helper response without printing a key or raw helper output.

**Tech Stack:** TypeScript, Vitest, Electron desktop main process, C# native helper protocol, PowerShell 5.1.

## Global Constraints

- The detailed native reason is local-log-only; UI, IPC, `BrowserDataImportError`, and user-facing copy remain unchanged.
- Never log or print helper raw stdout, requests, Chrome paths, keys, Cookie values, or LocalStorage values.
- Known generic failure reasons are exactly `helper_failed`, `broker_initialization_failed`, `controller_handshake_failed`, `service_channel_failed`, `elevation_failed`, `timeout`, `peer_verification_failed`, `service_failed`, `validation_failed`, `unsupported_key`, `cng_failed`, `decryption_failed`, and `service_cleanup_failed`.
- Any unknown or malformed generic helper response is logged as `invalid_response`.
- Keep `chrome_cookie_elevation_cancelled` and `chrome_cookie_helper_verification_failed` behavior unchanged.
- Use the existing desktop main logger; do not add renderer, relay, service-layer, or remote-control state.
- Add a Chinese bugfix comment explaining why the raw helper response must not be logged and why the stable reason was previously lost.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Log a safe helper failure reason at the protocol boundary

**Files:**
- Modify: `packages/desktop/src/main/windowsChromeAppBoundKey.ts`
- Test: `packages/desktop/test/windowsChromeAppBoundKey.test.ts`

**Interfaces:**
- Consumes: `HelperProcessResult.stdout`, `BrowserDataLogger.warn`, and the existing `WindowsChromeAppBoundImportError` codes.
- Produces: local warning `[browser-data] Windows Chrome App-Bound helper 返回失败` with `{ reason }`; public errors remain unchanged.

- [ ] **Step 1: Write the failing tests**

Add one test for a known generic reason and one for an unknown sensitive-looking response:

```ts
it("只把白名单 helper 失败原因写入本地日志", async () => {
  const fixture = await createFixture();
  const runHelper = vi.fn(async (_path: string, args: string[]) =>
    args[0] === "--version"
      ? { exitCode: 0, stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest" }
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

it("未知 helper 响应只记录 invalid_response 而不记录原文", async () => {
  const fixture = await createFixture();
  const secretMarker = "secret-path-or-key-material";
  const runHelper = vi.fn(async (_path: string, args: string[]) =>
    args[0] === "--version"
      ? { exitCode: 0, stdout: "ZCODE_BROWSER_IMPORT_HELPER\t2\tx64\t3.4.0\ttest" }
      : { exitCode: 0, stdout: `ZCODE_BROWSER_IMPORT_V1\tERR\t${secretMarker}` },
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
```

Use small test-local helpers only when they reduce repeated fixture options; do not add test-only production APIs.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsChromeAppBoundKey.test.ts
```

Expected: the new assertions fail because no safe native reason warning is emitted.

- [ ] **Step 3: Implement the minimal safe classifier and logging path**

Add an exact allowlist and a single generic-failure helper in `windowsChromeAppBoundKey.ts`:

```ts
const APP_BOUND_HELPER_FAILURE_REASONS = new Set([
  "helper_failed",
  "broker_initialization_failed",
  "controller_handshake_failed",
  "service_channel_failed",
  "elevation_failed",
  "timeout",
  "peer_verification_failed",
  "service_failed",
  "validation_failed",
  "unsupported_key",
  "cng_failed",
  "decryption_failed",
  "service_cleanup_failed",
]);

function throwAppBoundDecryptionFailure(
  logger: BrowserDataLogger,
  reason: string,
): never {
  // Bugfix 原因：helper 原本返回了稳定子错误码，但通用映射会丢失根因；这里只记录白名单值，禁止记录可能含密钥或路径的原始响应。
  logger.warn("[browser-data] Windows Chrome App-Bound helper 返回失败", {
    reason: APP_BOUND_HELPER_FAILURE_REASONS.has(reason) ? reason : "invalid_response",
  });
  throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
}
```

Change `parseHelperResponse` to receive `logger`, preserve the two existing special mappings, and route every other `ERR`, malformed response, non-zero `OK`, missing payload, invalid base64, or wrong key length through `throwAppBoundDecryptionFailure`. Pass `options.logger` from `readWindowsChromeAppBoundKey`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsChromeAppBoundKey.test.ts
```

Expected: all tests in the file pass and no warning output contains the secret marker.

- [ ] **Step 5: Run desktop regression checks**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/browserDataManager.test.ts packages/desktop/test/windowsChromeAppBoundKey.test.ts
pnpm typecheck
pnpm lint
```

Expected: both focused suites, TypeScript build, and lint pass.

- [ ] **Step 6: Commit the diagnostic implementation**

```powershell
git add -- packages/desktop/src/main/windowsChromeAppBoundKey.ts packages/desktop/test/windowsChromeAppBoundKey.test.ts
git commit -m "fix(desktop): retain browser helper failure reason"
```

### Task 2: Identify the real signed-helper failure without exposing browser secrets

**Files:**
- Read: `%LOCALAPPDATA%\Google\Chrome\User Data\Local State`
- Execute: `C:\Program Files\ZCode\resources\browser-import\zcode-browser-import-helper.exe`
- Inspect: Windows service list for `ZCodeBrowserImport_*`

**Interfaces:**
- Consumes: only the `APPB` encrypted key blob and discovered Chrome executable path in memory.
- Produces: `result=ok` or `result=error reason=<allowlisted reason|invalid_response>` and a residual-service count; never prints the helper payload.

- [ ] **Step 1: Run an approved one-shot probe against the installed signed helper**

Run the following outside the filesystem sandbox after approval. The user accepts the UAC prompt. The script reads `Local State`, strips the four-byte `APPB` prefix, sends the existing request through stdin, parses stdout entirely in memory, and prints only a classified result:

```powershell
$protocol = 'ZCODE_BROWSER_IMPORT_V1'
$helperPath = 'C:\Program Files\ZCode\resources\browser-import\zcode-browser-import-helper.exe'
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$localStatePath = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
$allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
@(
  'helper_failed', 'broker_initialization_failed', 'controller_handshake_failed',
  'service_channel_failed', 'elevation_cancelled', 'elevation_failed', 'timeout',
  'peer_verification_failed', 'service_failed', 'validation_failed',
  'unsupported_key', 'cng_failed', 'decryption_failed',
  'service_cleanup_failed', 'helper_verification_failed'
) | ForEach-Object { [void]$allowed.Add($_) }

$wrapped = $null
$encrypted = $null
$chromePathBytes = $null
$key = $null
try {
  $state = [IO.File]::ReadAllText($localStatePath) | ConvertFrom-Json
  $wrapped = [Convert]::FromBase64String($state.os_crypt.app_bound_encrypted_key)
  if ($wrapped.Length -le 4 -or [Text.Encoding]::ASCII.GetString($wrapped, 0, 4) -ne 'APPB') {
    throw 'invalid_app_bound_header'
  }
  $encrypted = [byte[]]::new($wrapped.Length - 4)
  [Buffer]::BlockCopy($wrapped, 4, $encrypted, 0, $encrypted.Length)
  $chromePathBytes = [Text.Encoding]::UTF8.GetBytes($chromePath)
  $request = "$protocol`t$([Convert]::ToBase64String($encrypted))`t$([Convert]::ToBase64String($chromePathBytes))"

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $helperPath
  $startInfo.Arguments = "--broker --parent-pid $PID"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.StandardInput.WriteLine($request)
  $process.StandardInput.Close()
  $response = $process.StandardOutput.ReadToEnd().Trim()
  if (-not $process.WaitForExit(90000)) {
    $process.Kill()
    Write-Output 'result=error reason=timeout'
    exit 1
  }

  $fields = $response.Split("`t")
  if ($fields.Length -eq 3 -and $fields[0] -eq $protocol -and $fields[1] -eq 'ERR') {
    $reason = if ($allowed.Contains($fields[2])) { $fields[2] } else { 'invalid_response' }
    Write-Output "result=error reason=$reason"
    exit 1
  }
  if ($fields.Length -eq 3 -and $fields[0] -eq $protocol -and $fields[1] -eq 'OK' -and $process.ExitCode -eq 0) {
    $key = [Convert]::FromBase64String($fields[2])
    if ($key.Length -eq 32) {
      Write-Output 'result=ok'
      exit 0
    }
  }
  Write-Output 'result=error reason=invalid_response'
  exit 1
} finally {
  if ($null -ne $wrapped) { [Array]::Clear($wrapped, 0, $wrapped.Length) }
  if ($null -ne $encrypted) { [Array]::Clear($encrypted, 0, $encrypted.Length) }
  if ($null -ne $chromePathBytes) { [Array]::Clear($chromePathBytes, 0, $chromePathBytes.Length) }
  if ($null -ne $key) { [Array]::Clear($key, 0, $key.Length) }
  $request = $null
  $response = $null
}
```

Do not echo the request or raw response.

- [ ] **Step 2: Check cleanup**

Run:

```powershell
Get-Service -Name 'ZCodeBrowserImport_*' -ErrorAction SilentlyContinue
```

Expected: no residual temporary service remains.

- [ ] **Step 3: Record the evidence and choose the next root-cause hypothesis**

Map the safe reason to exactly one failing boundary:

```text
elevation_failed / timeout       -> UAC or controller launch
peer_verification_failed         -> named-pipe PID/image verification
service_failed                   -> SCM create/start/readiness
validation_failed                -> Chrome path/isolation validation blob
unsupported_key                  -> Chrome post-process key format
cng_failed                       -> Google Chromekey1 CNG access/decrypt
decryption_failed                -> SYSTEM/user DPAPI or blob parsing
service_cleanup_failed           -> temporary service teardown
```

Expected: one concrete hypothesis is selected from runtime evidence before any root-cause code change. If a production fix is required, add its accepted behavior to the existing browser import spec and start a new focused TDD cycle.

---

### Task 3: Support credential-switch UAC without cross-account process reads

**Files:**
- Modify: `packages/desktop/native/windows-browser-import-helper/Program.cs`
- Test: `packages/desktop/test/windowsChromeAppBoundKey.test.ts`
- Update: `docs/browser-use/2026-07-13-browser-settings-spec.md`

- [ ] **Step 1: Add a failing native source contract**

Assert that the broker verifies the elevated controller by exact PID without requesting an image-path read, while the elevated controller and SYSTEM service continue calling `VerifyProcessImagePath` for the original broker.

- [ ] **Step 2: Run the focused test and verify RED**

Run the single Windows helper test file and confirm only the new credential-switch contract fails.

- [ ] **Step 3: Make the minimal identity-boundary change**

Add a `verifyClientImagePath` switch to `VerifyPipeClient`. Pass `false` only for the normal broker's verification of the exact `Process.Start` controller PID. Preserve the administrators-only pipe ACL, random token, reciprocal elevated-controller verification, and SYSTEM-service broker verification. Add a Chinese bugfix comment explaining that a standard user cannot reliably query a different administrator account's high-integrity process path.

- [ ] **Step 4: Run the focused test and verify GREEN**

Then rebuild the native helper. If local application control blocks the unsigned executable, record that the signed Windows smoke remains a release-artifact verification item rather than weakening policy or modifying the installed signed helper.
