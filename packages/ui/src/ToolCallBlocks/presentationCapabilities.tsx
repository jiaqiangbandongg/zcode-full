import { createContext, useContext, type ReactNode } from "react";
import type { AgentColor, ApplicationIconRequest, FileMediaPreview } from "@zcode/shared";

export interface ToolPresentationCapabilities {
  readMediaPreview?: (path: string) => Promise<FileMediaPreview>;
  getApplicationIcon?: (
    request: ApplicationIconRequest | string,
  ) => Promise<{ iconDataUrl: string } | null>;
  agentColor?: (name: string) => AgentColor | undefined;
  modelProviderName?: (providerId: string) => string | undefined;
  normalizeOutputText?: (text: string) => string;
  resourceUrl?: (ref: string) => string | undefined;
  readonly?: boolean;
}
const EMPTY_CAPABILITIES: ToolPresentationCapabilities = {};
const Context = createContext<ToolPresentationCapabilities>(EMPTY_CAPABILITIES);
export function ToolPresentationCapabilitiesProvider({
  value,
  children,
}: {
  value: ToolPresentationCapabilities;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useToolPresentationCapabilities() {
  return useContext(Context);
}
