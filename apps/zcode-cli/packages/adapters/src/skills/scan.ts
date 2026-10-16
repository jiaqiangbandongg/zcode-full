// ============================================================
// 技能根扫描规则（共享实现）
// ============================================================

// manifest 的 skills 项既可指向单个技能目录，也可指向一层技能集合。
// 根目录含 SKILL.md 时先识别根技能，再扫描一层子目录；与桌面发现规则保持一致，
// 避免把单个技能误当集合而静默漏扫。
// 插件发现链路（countSkillFiles / collectSkillComponents）是同步代码，技能 adapter 走
// fs/promises，因此提供 sync/async 两个变体，规则只写一份、由各自实现遵循。
//
// 错误契约：只吞「常态缺失」——路径不存在（ENOENT）或不是目录时返回空数组；其余错误
// （如 EACCES 权限、EMFILE）必须向上抛，由调用方决定发 skill_scan_failed 诊断还是
// 优雅降级。外层 catch 不能吞掉一切错误：权限错误会退化为静默空、skill_scan_failed
// 诊断成为死代码，重新引入了静默失败路径。
//
// 信任边界：plugin-scope 内容不可信，符号链接（含 Windows
// junction——Dirent.isSymbolicLink/lstat 对两者均返回 true）可指向插件根外的任意
// 目录或文件（目录级 skills/evil-link -> ../../outside、文件级 SKILL.md -> ~/.aws/
// credentials）。曾尝试 realpath containment，但边界作为可选参数沿数据流散布，每个
// 文件接触点都要记得校验（文件级链接、跨盘符 relative 谓词、manifest 失败回退均成
// 缺口）。收敛为单一规则：插件扫描一律不跟随符号链接——根自身、子目录候选、
// SKILL.md 文件三个粒度全部拒绝链接（拒绝即无逃逸，无需判定链接指向何处）。
// 用户级技能根（~/.zcode/skills 的 symlink 导入是受支持功能）保持默认跟随。

import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";

export interface ScanSkillFilesOptions {
  /**
   * 是否跟随符号链接（目录级与文件级），默认 true（用户级技能根的 symlink 导入
   * 是受支持功能）。plugin-scope 扫描必须传 false：链接可指向插件根外，拒绝
   * 链接即拒绝逃逸，无需 realpath 判定指向。
   */
  followSymbolicLinks?: boolean;
}

/**
 * 根目录下所有真实存在的 SKILL.md 绝对路径（含根自身）。
 * 根目录不存在或不是目录返回空数组；扫描过程中的其他错误（EACCES 等）向上抛。
 */
export async function scanSkillFilesUnderRoot(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): Promise<string[]> {
  const followSymlinks = options.followSymbolicLinks ?? true;
  // 根自身是链接（含 junction）时，插件扫描直接判空。
  if (!followSymlinks && (await isSymbolicLink(rootPath))) return [];

  const rootInfo = await stat(rootPath).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  // 根自身无 SKILL.md 是常态，继续扫一层子目录。
  if (await isLoadableSkillFile(own, followSymlinks)) files.push(own);

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    // 子目录命中的路径必须校验文件真实存在：分类目录（如 skills/engineering/）
    // 不是技能目录，拼出来的路径不存在；parseSkill 本会静默跳过，但计数与
    // 组件枚举都消费该结果，不校验会把「不存在的技能」算进来。
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (await isLoadableSkillFile(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/** scanSkillFilesUnderRoot 的同步变体，错误契约相同。 */
export function scanSkillFilesUnderRootSync(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): string[] {
  const followSymlinks = options.followSymbolicLinks ?? true;
  if (!followSymlinks && isSymbolicLinkSync(rootPath)) return [];

  const rootInfo = statSyncOrNull(rootPath);
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  if (isLoadableSkillFileSync(own, followSymlinks)) files.push(own);

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (isLoadableSkillFileSync(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/**
 * SKILL.md 候选的可加载判定：真实文件才收录。不跟随链接时符号链接文件
 * （含 junction）一律拒绝——这是文件级逃逸（SKILL.md -> 外部任意文件）的防线。
 */
async function isLoadableSkillFile(path: string, followSymlinks: boolean): Promise<boolean> {
  if (!followSymlinks && (await isSymbolicLink(path))) return false;
  const info = await stat(path).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  return info?.isFile() ?? false;
}

function isLoadableSkillFileSync(path: string, followSymlinks: boolean): boolean {
  if (!followSymlinks && isSymbolicLinkSync(path)) return false;
  return statSyncOrNull(path)?.isFile() ?? false;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymbolicLinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function statSyncOrNull(path: string): { isFile(): boolean; isDirectory(): boolean } | null {
  try {
    return statSync(path);
  } catch (error) {
    throwIfUnexpectedScanError(error);
    return null;
  }
}

/** ENOENT（路径不存在）是扫描常态，吞掉；其余错误（EACCES 等）向上抛。 */
function throwIfUnexpectedScanError(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}
