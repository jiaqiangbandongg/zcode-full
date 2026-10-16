import { describe, expect, it } from "vitest";
import {
  decodeMessageRow,
  decodePartRow,
  decodeSessionEntryRow,
  isCollaborationMode,
} from "../src/storage/session-store/codecs.js";

describe("session message model selection codec", () => {
  it("持久 mode codec 保留 guarded，不将其丢弃为默认值", () => {
    expect(isCollaborationMode("guarded")).toBe(true);
    expect(isCollaborationMode("unsupported")).toBe(false);
  });
  it("Timeline 当前 Selection 不从旧大写身份补值，也不暴露旧别名", () => {
    const part = decodePartRow({
      id: "part-current",
      message_id: "message-1",
      session_id: "session-1",
      sequence: 1,
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        toModel: {
          providerID: "old-provider",
          modelID: "old-model",
          variant: "high",
        },
        toModelSelection: { providerId: "current" },
      }),
    });
    expect(part).not.toHaveProperty("toModel");
    expect(JSON.stringify(part)).not.toContain("old-provider");
    expect(JSON.stringify(part)).not.toContain("old-model");
  });

  it.each([null, {}, { providerId: "new-provider" }])(
    "当前 user Selection 即使不完整也不回读旧 model：%j",
    (modelSelection) => {
      const message = decodeMessageRow({
        id: "message-new",
        session_id: "session-1",
        sequence: 1,
        time_created: 1,
        time_updated: 1,
        data: JSON.stringify({
          role: "user",
          modelSelection,
          model: { providerID: "old-provider", modelID: "old-model", variant: "high" },
        }),
      });
      expect(message).not.toHaveProperty("model");
      expect(message).not.toHaveProperty("modelSelection");
      expect(JSON.stringify(message)).not.toContain("old-provider");
    },
  );

  it.each([
    undefined,
    null,
    {},
    { providerId: "p" },
    { providerId: "p", modelId: "m", options: { reasoningLevel: 3 } },
  ])("无效 Subtask 选择不阻断正文读取：%j", (modelSelection) => {
    const part = decodePartRow({
      id: "part-subtask",
      message_id: "message-1",
      session_id: "session-1",
      sequence: 1,
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({
        type: "subtask",
        prompt: "保留子任务正文",
        description: "说明",
        agent: "worker",
        modelSelection,
      }),
    });
    expect(part).toMatchObject({ prompt: "保留子任务正文" });
    expect(part).not.toHaveProperty("model");
  });

  it("有效但当前不存在的 Timeline 模型与 label 保留，不检查 Registry", () => {
    const toModelSelection = {
      providerId: "removed-provider",
      modelId: "removed-model",
      label: "历史模型",
    };
    const part = decodePartRow({
      id: "part-timeline",
      message_id: "message-1",
      session_id: "session-1",
      sequence: 1,
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({ type: "timeline", timelineType: "model_change", toModelSelection }),
    });
    expect(part).toMatchObject({ toModel: toModelSelection });
  });

  it("当前 assistant 身份字段存在但缺失时，不从旧大写字段补值", () => {
    const message = decodeMessageRow({
      id: "message-new",
      session_id: "session-1",
      sequence: 1,
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({
        role: "assistant",
        providerId: "",
        modelId: "current",
        providerID: "old-provider",
        modelID: "old-model",
        variant: "high",
      }),
    });
    expect(message).not.toHaveProperty("providerID");
    expect(message).not.toHaveProperty("variant");
    expect(JSON.stringify(message)).not.toContain("old-provider");
  });

  it.each([{}, { reasoningLevel: "low" }, { reasoningLevel: 3 }])(
    "当前 entry options 优先，不能用 thoughtLevel 修补：%j",
    (options) => {
      const entry = decodeSessionEntryRow({
        id: "entry-current",
        session_id: "session-1",
        type: "runtime/model_selection",
        time_created: 1,
        time_updated: 1,
        data: JSON.stringify({
          providerId: "legacy-provider",
          modelId: "legacy-model",
          modelSelection: { providerId: "provider-a", modelId: "model-a", options },
          thoughtLevel: "high",
        }),
      });
      expect(entry.data).not.toHaveProperty("thoughtLevel");
      expect(entry.data).toMatchObject({ providerId: "provider-a", modelId: "model-a", options });
    },
  );

  it("已记账再升级缺新 User 字段时，不在 Reader 重新导入旧选择", () => {
    const message = decodeMessageRow({
      id: "message-1",
      session_id: "session-1",
      sequence: 1,
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({
        role: "user",
        time: { created: 1 },
        agent: "zcode-agent",
        model: { providerID: "provider-a", modelID: "model-a", variant: "high" },
      }),
    });

    expect(message).toMatchObject({ role: "user", agent: "zcode-agent" });
    expect(message).not.toHaveProperty("modelSelection");
    expect(message).not.toHaveProperty("model");
  });

  it("已记账再升级缺新 Assistant 字段时，不在 Reader 重新导入来源", () => {
    const message = decodeMessageRow({
      id: "message-2",
      session_id: "session-1",
      sequence: 2,
      time_created: 2,
      time_updated: 2,
      data: JSON.stringify({
        role: "assistant",
        time: { created: 2 },
        parentID: "message-1",
        providerID: "provider-a",
        modelID: "model-a",
        variant: "high",
        mode: "build",
        agent: "zcode-agent",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    });

    expect(message).toMatchObject({ role: "assistant", parentID: "message-1" });
    expect(message).not.toHaveProperty("providerId");
    expect(message).not.toHaveProperty("modelId");
    expect(message).not.toHaveProperty("providerID");
    expect(message).not.toHaveProperty("modelID");
    expect(message).not.toHaveProperty("variant");
  });

  it("已记账再升级缺新 Timeline 字段时，保留内容类型但不重新导入模型", () => {
    const part = decodePartRow({
      id: "part-1",
      message_id: "message-2",
      session_id: "session-1",
      sequence: 1,
      time_created: 2,
      time_updated: 2,
      data: JSON.stringify({
        type: "timeline",
        timelineType: "model_change",
        display: "separator",
        fromModel: { providerID: "provider-a", modelID: "model-a", variant: "low" },
        toModel: {
          providerID: "provider-b",
          modelID: "model-b",
          variant: "high",
          label: "Model B",
        },
      }),
    });

    expect(part).toMatchObject({ type: "timeline", timelineType: "model_change" });
    expect(part).not.toHaveProperty("fromModel");
    expect(part).not.toHaveProperty("toModel");
  });

  it("普通 entry reader 不再导入旧 thoughtLevel，必须先经过一次性迁移", () => {
    const entry = decodeSessionEntryRow({
      id: "entry-1",
      session_id: "session-1",
      type: "runtime/model_selection",
      time_created: 1,
      time_updated: 1,
      data: JSON.stringify({
        providerId: "provider-a",
        modelId: "model-a",
        thoughtLevel: "high",
      }),
    });
    expect(entry.data).toBeUndefined();
  });
});
