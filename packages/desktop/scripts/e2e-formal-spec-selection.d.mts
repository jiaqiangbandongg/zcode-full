export const SSH_FORMAL_SPEC_GLOB: string;

export function hasRequiredSshE2EEnvironment(
  env: Record<string, string | undefined>,
): boolean;

export function isSshFormalSpec(spec: string): boolean;

export function resolveEnvironmentGatedFormalSpecExcludes(options: {
  env: Record<string, string | undefined>;
  targeted: boolean;
}): string[];
