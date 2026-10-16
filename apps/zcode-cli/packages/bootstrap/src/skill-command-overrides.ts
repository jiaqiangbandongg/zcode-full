export interface EnableOverride {
  enable?: boolean;
}

export function collectDisabledPaths(
  overrides: Record<string, EnableOverride> | undefined,
): string[] {
  if (!overrides) return [];
  return Object.entries(overrides)
    .filter(([, value]) => value?.enable === false)
    .map(([path]) => path);
}
