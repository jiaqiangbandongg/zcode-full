import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServicePlatform } from "../platform/serviceManager.js";
import type { ServerLayout } from "./paths.js";

export interface StableLauncherBootstrap {
  command: string;
  entry: string;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stablePosixLauncher(bootstrap?: StableLauncherBootstrap): string {
  const fallback = bootstrap
    ? `exec ${quoteShell(bootstrap.command)} ${quoteShell(bootstrap.entry)} "$@"`
    : "echo \"No current ZCode Server release\" >&2; exit 1";
  return `#!/bin/sh
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RELEASE_DIR=$(sed -n 's/.*"releaseDir"[[:space:]]*:[[:space:]]*"\\([^"\\]*\\)".*/\\1/p' "$ROOT/current.json")
if [ -n "$RELEASE_DIR" ]; then
  case "$RELEASE_DIR" in
    "$ROOT/releases"/*) ;;
    *) echo "Invalid current ZCode Server release" >&2; exit 1 ;;
  esac
  exec "$RELEASE_DIR/runtime/node" "$RELEASE_DIR/runtime/server-cli.js" "$@"
fi
${fallback}
`;
}

function quoteBatch(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableWindowsLauncher(bootstrap?: StableLauncherBootstrap): string {
  const fallback = bootstrap
    ? `${quoteBatch(bootstrap.command)} ${quoteBatch(bootstrap.entry)} %*\r\n`
    : "echo No current ZCode Server release 1>&2\r\nexit /b 1\r\n";
  return `@echo off\r
set "ROOT=%~dp0.."\r
set "ZCODE_SERVER_ROOT=%ROOT%"\r
powershell -NoProfile -NonInteractive -Command "$root=[IO.Path]::GetFullPath($env:ZCODE_SERVER_ROOT); $current=Join-Path $root 'current.json'; if (Test-Path -LiteralPath $current) { $j=Get-Content -Raw -LiteralPath $current ^| ConvertFrom-Json; if ($j.releaseDir) { $release=[IO.Path]::GetFullPath([string]$j.releaseDir); $releases=[IO.Path]::GetFullPath((Join-Path $root 'releases')); if (-not $release.StartsWith($releases + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { exit 1 } } }"\r
if errorlevel 1 (\r
  echo Invalid current ZCode Server release 1>&2\r
  exit /b 1\r
)\r
for /f "delims=" %%I in ('powershell -NoProfile -Command "$path=Join-Path $env:ZCODE_SERVER_ROOT 'current.json'; if (Test-Path -LiteralPath $path) { $j=Get-Content -Raw -LiteralPath $path ^| ConvertFrom-Json; $j.releaseDir }"') do set "RELEASE_DIR=%%I"\r
if not "%RELEASE_DIR%"=="" (\r
  "%RELEASE_DIR%\\runtime\\node.exe" "%RELEASE_DIR%\\runtime\\server-cli.js" %*\r
  exit /b %ERRORLEVEL%\r
)\r
${fallback}`;
}

export async function writeStableLauncher(
  layout: ServerLayout,
  platform: ServicePlatform,
  bootstrap?: StableLauncherBootstrap,
): Promise<string> {
  await mkdir(layout.stableBinDir, { recursive: true, mode: 0o700 });
  const launcherPath = join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode");
  const temporaryPath = `${launcherPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    platform === "win32" ? stableWindowsLauncher(bootstrap) : stablePosixLauncher(bootstrap),
    platform === "win32" ? "utf8" : { encoding: "utf8", mode: 0o755 },
  );
  await rename(temporaryPath, launcherPath);
  return launcherPath;
}
