import type { WebRequest } from "electron";
export function installRequestSecurityDiagnostics(
  _request: WebRequest,
  _logger: { info(tag: string, fields: Record<string, unknown>): void },
): void {}
export function decorateRequestSecurityLogArgs(args: unknown[], _webContentsId: number): unknown[] {
  return args;
}
