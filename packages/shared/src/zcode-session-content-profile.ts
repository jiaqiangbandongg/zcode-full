// session/read 的 contentProfile="index" 裁剪。
// 背景：task index 每次 turn 完成 / 改标题 / 变可见都会 existing-only 读一次 session，
// 旧实现拿到的是完整历史（长 session 单行可达 ~15MB），host stdio 与 JSON 解析被打满，
// 而 index 只需要 title / searchableText / hasUserVisibleContent / status / model。
// 这里只剥离这些派生都不读取的大载荷字段，保持 message / part 数量、顺序、id、type、metadata 不变，
// 以保证可见性与投影策略判定和 full snapshot 完全一致（spec：docs/task/task-sqlite-index.md「Index read profile」）。
// 不能改用 messageLimit：searchableText 取前 200K 字符、标题回退首条真实用户输入，都依赖历史开头。
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import type { ZCodeMessagePart, ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";

export type ZCodeSessionContentProfile = "full" | "index";

const ELIDED_DATA_URL = "data:,";

function elidePartForIndex(part: ZCodeMessagePart): ZCodeMessagePart {
  switch (part.type) {
    case "reasoning":
      return part.text ? { ...part, text: "" } : part;
    case "file":
      return part.url.startsWith("data:") && part.url !== ELIDED_DATA_URL
        ? { ...part, url: ELIDED_DATA_URL }
        : part;
    case "tool": {
      const state = part.state;
      switch (state.status) {
        case "pending":
          return { ...part, state: { ...state, input: {}, raw: "" } };
        case "running":
          return {
            ...part,
            state: { ...state, input: {}, ...(state.metadata ? { metadata: {} } : {}) },
          };
        case "completed":
          return { ...part, state: { ...state, input: {}, output: "", metadata: {} } };
        case "error":
          return {
            ...part,
            state: { ...state, input: {}, error: "", ...(state.metadata ? { metadata: {} } : {}) },
          };
        default:
          return part;
      }
    }
    default:
      return part;
  }
}

function elideMessageForIndex(message: ZCodeMessageWithParts): ZCodeMessageWithParts {
  let changed = false;
  const parts = message.parts.map((part) => {
    const next = elidePartForIndex(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

/** 生成 task index 专用的轻量 snapshot；不修改入参（CLI 侧 messages 可能来自共享缓存）。 */
export function elideSessionSnapshotForIndex<T extends ZCodeSessionStateSnapshot>(snapshot: T): T {
  return { ...snapshot, messages: snapshot.messages.map(elideMessageForIndex) };
}
