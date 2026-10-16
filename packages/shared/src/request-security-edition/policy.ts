export const requestSecuritySensitiveHeaders: readonly string[] = [];
export function isRequestSecurityFailure(
  _body: unknown,
  _codes: readonly (string | undefined)[],
): boolean {
  return false;
}
