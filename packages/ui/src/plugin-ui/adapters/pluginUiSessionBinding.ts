import type {
  PluginUiSessionScope,
  PluginUiSessionActions,
  PluginUiSessionCommandPort,
} from "@/plugin-ui/contract.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

/** 会话动作统一翻译 ACK；状态与发送配置始终由原会话入口管理。 */
export function createPluginUiSessionActions(
  _scope: PluginUiSessionScope,
  port: PluginUiSessionCommandPort,
): PluginUiSessionActions {
  return {
    async sendFollowUp({ prompt, source, images }) {
      // S3：图片先上传拿 ref（与粘贴截图同链路），上传失败整条不发。
      const attachments = [];
      for (const [index, image] of (images ?? []).entries()) {
        attachments.push(
          await port.uploadAttachment({
            fileName: buildPluginUiImageFileName(
              source.kind === "pluginUi" ? source.pluginId : "gen-ui",
              index,
              image.mimeType,
            ),
            mime: image.mimeType,
            dataBase64: image.dataBase64,
          }),
        );
      }
      const result = await port.sendText(prompt, {
        source,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // 修复：原发送入口正常 ACK 后返回 undefined；不能把已发送消息误报为失败。
      if (result === "blocked" || result === "confirmationRequired")
        throw new Error("Session is not ready to accept input");
    },
  };
}
