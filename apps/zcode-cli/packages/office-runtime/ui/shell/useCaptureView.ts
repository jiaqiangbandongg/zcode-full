import { useEffect, type RefObject } from "react";
import { formatAnchor, splitAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { getHost } from "#ui/host.ts";
import type { LoadedDoc } from "#ui/shell/state.ts";
import type { ViewerHandle } from "#ui/viewers/types.ts";

/**
 * 页面工具 capture_view：Agent 截取面板当前文档的某处画面。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模，行为不变；只在挂载时注册一次，通过 ref 读取最新文档与查看器。
 */
export function useCaptureView(
  docRef: RefObject<LoadedDoc | null>,
  viewer: RefObject<ViewerHandle | null>,
) {
  useEffect(() => {
    const host = getHost();
    host.handleTool("capture_view", async (args) => {
      const current = docRef.current;
      if (!current || !viewer.current)
        throw new Error(
          `No document is open in the ${PROFILE.title.en} panel. Call open_document first.`,
        );
      let at: string | null = null;
      if (typeof args.anchor === "string" && args.anchor.trim()) {
        const split = splitAnchor(args.anchor);
        if (split.path.replace(/^\.\//, "") !== current.info.path)
          throw new Error(
            `The panel shows ${current.info.path}, not ${split.path}. Call open_document with that path first.`,
          );
        at = split.at;
      }
      const maxWidth =
        typeof args.maxWidth === "number" ? Math.min(2000, Math.max(320, args.maxWidth)) : 1600;
      const shot = await viewer.current.capture(at, maxWidth);
      return {
        content: [
          { type: "image", data: shot.data, mimeType: "image/png" },
          {
            type: "text",
            text: `Captured ${formatAnchor(current.info.path, shot.at)} (${shot.width}×${shot.height} px).`,
          },
        ],
      };
    });
  }, [docRef, viewer]);
}
