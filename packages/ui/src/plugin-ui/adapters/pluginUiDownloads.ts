import type { PluginUiHostScope } from "@/plugin-ui/app/pluginUiHostController.js";
import type { PluginUiInteractionCallbacks } from "@/plugin-ui/app/pluginUiInteractionPorts.js";
import type { PluginUiPresentation } from "@/plugin-ui/contract.js";
import type { IPluginUiBridgeService, PluginUiReadResourceResult } from "@zcode/services";
import type { IPlatformService, SaveFileRequest, SaveFileResult } from "@zcode/shared";
import type { McpAppsDownloadFileItem } from "@zcode/shared/mcp-apps";
import { MCP_APPS_DOWNLOAD_FILE_MAX_BYTES } from "@zcode/shared/mcp-apps";
import {
  decodedBase64Length,
  planPluginUiDownload,
  resolvePluginUiDownloadFileName,
} from "../domain/pluginUiDownloadFile.js";

export interface PluginUiDownloadHandlerDeps {
  /** 桌面 IPlatformService.saveFile：原生另存为对话框；main 侧再做一次 50 MiB 与文件名校验。 */
  saveFile(payload: SaveFileRequest): Promise<SaveFileResult>;
  /** 只有 uri 的项（ResourceLink / 无内容的 EmbeddedResource）先经同插件 server 读取。 */
  readResource(uri: string): Promise<PluginUiReadResourceResult>;
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * `ui/download-file { contents }` 的宿主实现。逐项解析内容 → 逐个弹保存框（多项多次），
 * 不要求用户手势（已拍板：保存框本身就是确认）。任一项取消 / 写入失败 → `{ isError: true }`（官方 SDK 语义），
 * 参数级错误（超 50 MiB、blob 非法、链接资源无内容）→ -32602；读资源失败按 -32603 抛给页面。
 */
/**
 * 宿主实例的 downloadFile 交互：平台有原生 saveFile（桌面）才提供；链接项经本插件 server 的 readResource 读取。
 * 返回 undefined 表示本实例不声明 downloadFile 能力，端口回 -32601（与其它交互回调同一规则）。
 */
export function createPluginUiDownloadInteraction(input: {
  platform: Pick<IPlatformService, "saveFile"> | null;
  bridge: Pick<IPluginUiBridgeService, "readResource">;
  scope: PluginUiHostScope;
  getInstance(): import("@zcode/shared/mcp-apps").McpAppInstance;
  presentation: Pick<PluginUiPresentation, "pluginId" | "serverName">;
}): Required<Pick<PluginUiInteractionCallbacks, "onDownloadFile">> | undefined {
  const saveFile = input.platform?.saveFile;
  if (!saveFile) return undefined;
  const { scope, presentation } = input;
  return {
    onDownloadFile: createPluginUiDownloadHandler({
      saveFile: (payload) => saveFile.call(input.platform, payload),
      readResource: (uri) =>
        input.bridge.readResource({
          instance: input.getInstance(),
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
          sessionId: scope.sessionId,
          pluginId: presentation.pluginId,
          serverName: presentation.serverName,
          uri,
        }),
    }),
  };
}

export function createPluginUiDownloadHandler(deps: PluginUiDownloadHandlerDeps) {
  const resolveBytes = async (
    plan: ReturnType<typeof planPluginUiDownload>,
  ): Promise<{ data: ArrayBuffer; name: string }> => {
    const source = plan.source;
    if (source.kind === "text") {
      return { data: toArrayBuffer(new TextEncoder().encode(source.text)), name: plan.name };
    }
    if (source.kind === "blob") {
      if (decodedBase64Length(source.blob) > MCP_APPS_DOWNLOAD_FILE_MAX_BYTES) {
        throw rpcError(
          -32602,
          `file_too_large: ${plan.name} exceeds ${MCP_APPS_DOWNLOAD_FILE_MAX_BYTES} bytes`,
        );
      }
      try {
        return { data: toArrayBuffer(decodeBase64(source.blob)), name: plan.name };
      } catch {
        throw rpcError(-32602, `invalid_blob: ${plan.name} is not valid base64`);
      }
    }
    const result = await deps.readResource(source.uri);
    const content = result.contents.find((entry) => entry.uri === source.uri) ?? result.contents[0];
    if (!content || (typeof content.text !== "string" && typeof content.blob !== "string")) {
      throw rpcError(-32602, `resource_not_found: ${source.uri} has no downloadable content`);
    }
    // 链接项的文件名 / mimeType 以读到的资源为准补全扩展名。
    const name = resolvePluginUiDownloadFileName(
      { name: plan.name, mimeType: plan.mimeType ?? content.mimeType },
      0,
    );
    return resolveBytes({
      name,
      mimeType: plan.mimeType ?? content.mimeType,
      source:
        typeof content.text === "string"
          ? { kind: "text", text: content.text }
          : { kind: "blob", blob: content.blob as string },
    });
  };

  return async (contents: McpAppsDownloadFileItem[]): Promise<{ isError?: boolean }> => {
    let failed = false;
    for (const [index, item] of contents.entries()) {
      const { data, name } = await resolveBytes(planPluginUiDownload(item, index));
      if (data.byteLength === 0 || data.byteLength > MCP_APPS_DOWNLOAD_FILE_MAX_BYTES) {
        throw rpcError(
          -32602,
          `file_too_large: ${name} must be 1..${MCP_APPS_DOWNLOAD_FILE_MAX_BYTES} bytes`,
        );
      }
      const saved = await deps.saveFile({ data, suggestedName: name });
      if (!saved.success) failed = true;
    }
    return failed ? { isError: true } : {};
  };
}
