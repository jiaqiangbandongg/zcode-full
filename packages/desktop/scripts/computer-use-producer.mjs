import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 判定当前安装的 `@zcode/zcode-cua` 是闭源真实 producer 还是开源占位包。
 *
 * 闭源构建依赖私有仓的真实 producer；开源导出把它换成 `packages/zcode-cua` 占位包，
 * 占位包在 package.json 声明 `zcodeCuaPlaceholder: true`，所有能力 fail-closed。
 * 开发、构建与打包里只服务于真实 Computer Use 的步骤（构建 Helper、暂存插件原生依赖、
 * Windows Helper 资源、打包后的 Helper 校验）都以本判定为门，检测不到真实 producer 时跳过，
 * 不能因为缺少私有产物让开源树的入口失败。规范见 docs/desktop/computer-use-producer-detection.md。
 *
 * 构建配置（electron-builder、tsup）同步求值，这里只做一次小文件同步读取。
 */
export function readComputerUseProducer({ desktopPackageRoot }) {
  // 从桌面包向上查找最近的安装：闭源 hoisted 布局在仓库根，开源占位包链接在桌面包下。
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    const manifestPath = resolve(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return {
        installed: true,
        placeholder: manifest.zcodeCuaPlaceholder === true,
        manifest,
        packageRoot: dirname(manifestPath),
      };
    }
    if (dirname(dir) === dir) return { installed: false, placeholder: false };
  }
}

export function isRealComputerUseProducerInstalled({ desktopPackageRoot }) {
  const producer = readComputerUseProducer({ desktopPackageRoot });
  return producer.installed && !producer.placeholder;
}
