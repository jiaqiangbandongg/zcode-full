// 会话常驻 Selection 的恢复回归。
// Bug 现场：旧版分叉把分叉点的加速卡选型写进 child 的 runtime/model_selection entry，
// 这类会话恢复后常驻在隐藏的 `account:*-highspeed-card` 上，UI 模型选择器一片空白。
import { describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { HIGHSPEED_PROVIDER_IDS } from "@zcode/shared";
import { readSessionModelSelection } from "../src/app/session-store.js";

const SESSION_ID = "sess_restore" as SessionId;

function storeWithEntryData(data: unknown): Pick<SessionStorePort, "sessionEntries"> {
  const entry = {
    id: `${SESSION_ID}:runtime-model-selection`,
    sessionID: SESSION_ID,
    type: SESSION_ENTRY_MODEL_SELECTION,
    time: { created: 1, updated: 1 },
    data,
  } as SessionEntryInfo;
  return { sessionEntries: async () => [entry] } as Pick<SessionStorePort, "sessionEntries">;
}

describe("恢复会话常驻 Selection", () => {
  it("丢弃持久化的加速卡选型，让会话回到未绑定", async () => {
    for (const providerId of Object.values(HIGHSPEED_PROVIDER_IDS)) {
      await expect(
        readSessionModelSelection(
          storeWithEntryData({
            providerId,
            modelId: "GLM-5.3",
            options: { reasoningLevel: "max" },
          }),
          SESSION_ID,
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("普通选型原样恢复", async () => {
    await expect(
      readSessionModelSelection(
        storeWithEntryData({
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "max" },
        }),
        SESSION_ID,
      ),
    ).resolves.toEqual({
      providerId: "account:bigmodel-team-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "max" },
    });
  });

  it("档位非法走模型身份兜底时同样过滤加速卡", async () => {
    // 兜底分支只捞 providerId/modelId，加速 Provider 不能借这条路径复活。
    await expect(
      readSessionModelSelection(
        storeWithEntryData({
          providerId: HIGHSPEED_PROVIDER_IDS.bigmodel,
          modelId: "GLM-5.3",
          options: { reasoningLevel: 3 },
        }),
        SESSION_ID,
      ),
    ).resolves.toBeUndefined();
    await expect(
      readSessionModelSelection(
        storeWithEntryData({
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3",
          options: { reasoningLevel: 3 },
        }),
        SESSION_ID,
      ),
    ).resolves.toEqual({ providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" });
  });

  it("没有 entry 时返回空", async () => {
    await expect(
      readSessionModelSelection({ sessionEntries: async () => [] }, SESSION_ID),
    ).resolves.toBeUndefined();
    await expect(readSessionModelSelection({}, SESSION_ID)).resolves.toBeUndefined();
  });
});
