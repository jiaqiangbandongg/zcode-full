export function androidApiLevel(): number {
  return intEnv("ANDROID_PLUGIN_API_LEVEL", 35);
}

export function androidBuildToolsVersion(): string {
  return stringEnv("ANDROID_PLUGIN_BUILD_TOOLS_VERSION", "35.0.0");
}

export function androidSystemImageVariant(): string {
  return stringEnv("ANDROID_PLUGIN_SYSTEM_IMAGE_VARIANT", "default");
}

export function androidSystemImageAbi(): string {
  return stringEnv(
    "ANDROID_PLUGIN_SYSTEM_IMAGE_ABI",
    process.arch === "arm64" ? "arm64-v8a" : "x86_64",
  );
}

export function androidSystemImagePackage(): string {
  return `system-images;android-${androidApiLevel()};${androidSystemImageVariant()};${androidSystemImageAbi()}`;
}

export function javaMajorVersion(): string {
  return stringEnv("ANDROID_PLUGIN_JDK_MAJOR", "17");
}

function stringEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
