import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";

export const DEV_ELECTRON_PROTOCOL_SCHEME = "zcode";
export const DEV_ELECTRON_APP_NAME = "ZCode Dev";
export const DEV_ELECTRON_APP_BUNDLE_ID = "dev.zcode.app.development";
// 副本布局版本，见 prepareDevElectronAppBundle 中的指纹说明。
export const DEV_ELECTRON_BUNDLE_FORMAT = 2;

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

function replacePlistString(plist, key, value) {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
  if (!pattern.test(plist)) {
    throw new Error(`Dev Electron Info.plist is missing ${key}`);
  }
  return plist.replace(
    pattern,
    (_match, prefix, suffix) => `${prefix}${escapeXml(value)}${suffix}`,
  );
}

function appendProtocolDeclaration(plist) {
  if (plist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`)) {
    return plist;
  }

  const closingDictIndex = plist.lastIndexOf("</dict>");
  if (closingDictIndex < 0) {
    throw new Error("Dev Electron Info.plist is missing its root dict");
  }

  const protocolDeclaration = `\n\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>${DEV_ELECTRON_APP_NAME}</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
  return `${plist.slice(0, closingDictIndex)}${protocolDeclaration}${plist.slice(closingDictIndex)}`;
}

/**
 * 为 macOS 本地 Dev runtime 写入产品身份和 zcode URL scheme。
 * raw Electron 的 Info.plist 没有 CFBundleURLTypes，系统只能把 zcode 交给
 * com.github.Electron；这里仅修改启动副本，避免污染 node_modules 中的 Electron。
 */
export function patchDevElectronInfoPlist(plist) {
  let patched = replacePlistString(plist, "CFBundleDisplayName", DEV_ELECTRON_APP_NAME);
  patched = replacePlistString(patched, "CFBundleIdentifier", DEV_ELECTRON_APP_BUNDLE_ID);
  patched = replacePlistString(patched, "CFBundleName", DEV_ELECTRON_APP_NAME);
  return appendProtocolDeclaration(patched);
}

export function resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch }) {
  return posix.join(runtimeRoot, `${electronVersion}-${arch}`, `${DEV_ELECTRON_APP_NAME}.app`);
}

export async function prepareDevElectronAppBundle({
  electronAppPath,
  runtimeRoot,
  electronVersion,
  arch,
}) {
  const appPath = resolveDevElectronAppBundlePath({ runtimeRoot, electronVersion, arch });
  const infoPlistPath = posix.join(appPath, "Contents", "Info.plist");
  const sourceExecutablePath = posix.join(electronAppPath, "Contents", "MacOS", "Electron");
  const existingExecutablePath = posix.join(appPath, "Contents", "MacOS", "Electron");
  // 源二进制的身份指纹，写在 .app 外面：放进 Contents 会污染 bundle 结构。
  const sourceStampPath = posix.join(dirname(appPath), ".zcode-dev-electron-source.json");
  // 修复原因：这里原本把两个 Electron 可执行文件（各 ~100MB+）整份读进内存做 equals，
  // 每次 dev 启动都要付一次全量读盘。源二进制由 npm 包解压产出，记录它的 size+mtime
  // 即可判定是否需要重拷，语义等价而开销是常数级。
  //
  // 不直接比较「源与副本」的 mtime：cp 即使开 preserveTimestamps 也会把 mtime
  // 四舍五入到毫秒，源的亚毫秒精度必然丢失，两边永远不相等 —— 那等于没有缓存。
  //
  // format 字段记录副本的布局版本：布局修复（例如符号链接策略变更）时递增，
  // 让已存在的旧副本在源二进制没变的情况下也能被判定为需要重拷。
  const sourceStats = await stat(sourceExecutablePath).catch(() => undefined);
  const sourceStamp = sourceStats
    ? JSON.stringify({
        format: DEV_ELECTRON_BUNDLE_FORMAT,
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      })
    : undefined;
  let needsCopy = true;
  try {
    const existingInfoPlist = await readFile(infoPlistPath, "utf8");
    await access(existingExecutablePath);
    const existingStamp = await readFile(sourceStampPath, "utf8");
    needsCopy =
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_APP_BUNDLE_ID}</string>`) ||
      !existingInfoPlist.includes(`<string>${DEV_ELECTRON_PROTOCOL_SCHEME}</string>`) ||
      sourceStamp === undefined ||
      existingStamp !== sourceStamp;
  } catch {
    // 目录不存在、来源不是本工具生成的 bundle，下面走一次完整复制。
  }

  if (needsCopy) {
    // 只删除本次生成的 ignored runtime 目录，绝不触碰 node_modules 或用户数据。
    await rm(appPath, { recursive: true, force: true });
    await rm(sourceStampPath, { force: true });
    await mkdir(dirname(appPath), { recursive: true });
    // verbatimSymlinks 必须开：Electron Framework.framework 内部靠相对符号链接
    // （Resources -> Versions/Current/Resources、Current -> A）组织。fs.cp 默认会把
    // 相对链接改写成指向 node_modules 的绝对路径，主进程仍能读到，但 GPU / network
    // 等 macOS 沙箱子进程只允许读本 bundle 目录，顺链接出去会被拦，表现为
    // "icudtl.dat not found in bundle" 然后 "GPU process isn't usable. Goodbye."。
    await cp(electronAppPath, appPath, { recursive: true, verbatimSymlinks: true });
    const patchedInfoPlist = patchDevElectronInfoPlist(await readFile(infoPlistPath, "utf8"));
    await writeFile(infoPlistPath, patchedInfoPlist, "utf8");
    // 指纹最后写：中途失败时下次仍会判定为需要重拷，不会留下半成品缓存。
    if (sourceStamp !== undefined) await writeFile(sourceStampPath, sourceStamp, "utf8");
  }

  return {
    appPath,
    executablePath: posix.join(appPath, "Contents", "MacOS", "Electron"),
  };
}
