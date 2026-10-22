/**
 * 手写声明的原因：`desktop-product-identity.mjs` 是构建脚本与 main 进程共用的 ESM 模块，
 * 仓库未开启 allowJs，缺少本文件时 TS 会把它整体当成隐式 any，main 侧调用点就失去类型校验。
 * 合并冲突原因：本文件曾停留在旧接口（identity 上带 artifactSuffix、只有单轴的
 * resolveWindowsAppUserModelId），而实现已把「产品身份 flavor」和「后端环境 artifactSuffix」拆成两轴，
 * 导致 main/index.ts 导入 resolveWindowsAppUserModelIdForFlavor 时报 TS2724。
 * 改 .mjs 导出时必须同步本文件。
 */
export type DesktopProductFlavor = "production" | "preview";

export interface DesktopProductIdentity {
  readonly flavor: DesktopProductFlavor;
  readonly appId: string;
  readonly productName: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageName: string;
  readonly cuaHelperInstallVariant: "preview" | null;
}

export const ZCODE_PREVIEW_IDENTITY_ENV: "ZCODE_PREVIEW_IDENTITY";

export function isPreviewIdentityRequested(env?: Record<string, string | undefined>): boolean;
export function resolveDesktopProductFlavor(
  env?: Record<string, string | undefined>,
): DesktopProductFlavor;
export function resolveDesktopProductIdentity(
  env?: Record<string, string | undefined>,
): DesktopProductIdentity;
export function resolveDesktopArtifactSuffix(env?: Record<string, string | undefined>): string;
export function resolveWindowsAppUserModelIdForFlavor(
  flavor: DesktopProductFlavor,
  runtime?: { isPackaged: boolean },
): string;
export function resolveWindowsAppUserModelId(
  env?: Record<string, string | undefined>,
  runtime?: { isPackaged: boolean },
): string;
export const desktopProductIdentities: Readonly<{
  production: DesktopProductIdentity;
  preview: DesktopProductIdentity;
}>;
