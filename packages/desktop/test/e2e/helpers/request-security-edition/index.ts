import type { E2ENetworkCaptureResponseMock } from "../network-capture-proxy.js";
export function requestSecurityCaptureMocks(
  _env: NodeJS.ProcessEnv,
  _preset: string,
): E2ENetworkCaptureResponseMock[] | undefined {
  return undefined;
}
export function recordRequestSecurityCaptureMode(_env: NodeJS.ProcessEnv, _mocked: boolean): void {}
export function requestSecurityWorkerEnv(_env: NodeJS.ProcessEnv): Record<string, string> {
  return {};
}
export function requestSecurityEndpointEnv(_preset: string, _mode: string): Record<string, string> {
  return {};
}
export function restoreRequestSecurityEndpointEnv(
  _env: NodeJS.ProcessEnv,
  _preset: string,
  _mode: string,
): void {}
export function requestSecurityClientConfig(): Record<string, never> {
  return {};
}
export function isRequestSecuritySpec(_name: string | undefined): boolean {
  return false;
}
export function requestSecuritySpecTimeout(_specs: string[], fallback: number): number {
  return fallback;
}
export async function startRequestSecurityFixture(
  _specs: string[],
  _directory: string,
): Promise<void> {}
export async function stopRequestSecurityFixture(): Promise<void> {}

export function requestSecurityAgentConfig(): Record<string, never> {
  return {};
}
