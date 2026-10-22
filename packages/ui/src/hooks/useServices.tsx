/**
 * useServices —— 通过 React Context 提供 IServiceAccessor
 *
 * 替代 props drilling，组件通过 useServices() 直接获取服务。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";

const ServiceContext = createContext<IServiceAccessor | null>(null);
const ComposerClientNamespaceContext = createContext("desktop");

/** 手机同源可连接多台桌面；稳定设备身份不能用临时 bridge ID 替代。 */
export function useComposerClientNamespace(): string {
  return useContext(ComposerClientNamespaceContext);
}

export function ServiceProvider({
  services,
  children,
  composerClientNamespace,
}: {
  services: IServiceAccessor;
  children: ReactNode;
  composerClientNamespace?: string;
}) {
  const inheritedNamespace = useComposerClientNamespace();
  return (
    <ComposerClientNamespaceContext.Provider value={composerClientNamespace ?? inheritedNamespace}>
      <ServiceContext.Provider value={services}>{children}</ServiceContext.Provider>
    </ComposerClientNamespaceContext.Provider>
  );
}

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx;
}

export function useOptionalServices(): IServiceAccessor | null {
  return useContext(ServiceContext);
}
