import type { IServiceAccessor } from "@zcode/services";

/**
 * 快捷键 label 链（useShortcutCommandLabel → useSettings → useServices）所需的最小服务工厂。
 *
 * 背景：设置页快捷键特性让 NewTaskButtonGroup / WindowsCaptionMenuButton /
 * WorkspaceHeaderActionSection / WorkspaceSidebar 等组件通过 useShortcutCommandLabel
 * 展示生效键位，该 hook 经 useSettings 读 ServiceContext；这些组件在真实 App 中
 * 恒处于 Root 的 ServiceProvider 之下，裸渲染的单测必须同样提供 Provider。
 * renderToStaticMarkup 不跑 effect，get 不会被调用；@testing-library 场景下
 * get 返回空对象 → 生效表回退默认绑定。
 */
export function createSettingsTestServices(): IServiceAccessor {
  return {
    settingService: {
      get: async () => ({}),
      update: async () => {},
    },
  } as unknown as IServiceAccessor;
}
