import {
  createBotsServiceHarness,
  createFeishuCallback,
  createFeishuConfig,
  createRecordingFeishuFetch,
  readBotSyntheticFixture,
  type RecordedRequest,
} from "../../helpers/bots-service-harness.js";

describe("BOT-E2E-DF-01 Feishu delivery diagnostics", () => {
  it("retains business errors, recovers delivery, and rejects group task input", async () => {
    // 合成飞书业务拒绝；验证客户端错误链路，不冒充真实租户复现。
    const fixture = await readBotSyntheticFixture("feishu-delivery-error.json");
    expect(fixture.caseId).toBe("BOT-E2E-DF-01");
    const originalFetch = globalThis.fetch;
    const requests: RecordedRequest[] = [];
    const recordingFetch = createRecordingFeishuFetch(requests);
    let failed = true;
    globalThis.fetch = async (input, init) => {
      const response = await recordingFetch(input, init);
      if (failed && String(input).includes("/im/v1/messages?")) {
        return new Response(
          JSON.stringify({
            code: 230101,
            msg: "Sending messages to users is temporarily unavailable.",
            error: { log_id: "E2E_DELIVERY_LOG" },
          }),
        );
      }
      return response;
    };
    const harness = createBotsServiceHarness({ config: createFeishuConfig() });
    try {
      await expect(
        harness.service.handleProviderCallbackResponse(
          "feishu",
          createFeishuCallback("feishu-e2e", "/status"),
        ),
      ).rejects.toThrow("code=230101");
      const status = (await harness.service.getStatus()).botRuntime[0];
      expect(status?.deliveryError).toContain("code=230101");
      expect(status?.deliveryError).toContain("log_id=E2E_DELIVERY_LOG");
      expect(status?.status).not.toBe("error");
      const writes = requests.filter((request) => request.url.includes("/im/v1/messages?"));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((request) => request.url.includes("receive_id_type=open_id"))).toBe(true);
      failed = false;
      const next = createFeishuCallback("feishu-e2e", "/status");
      next.event.message.message_id += "_recovery";
      await harness.service.handleProviderCallbackResponse("feishu", next);
      expect((await harness.service.getStatus()).botRuntime[0]?.deliveryError).toBeUndefined();
      const group = createFeishuCallback("feishu-e2e", "E2E_GROUP_UNSUPPORTED");
      group.event.message.chat_type = "group";
      group.event.message.message_id += "_group";
      const result = await harness.service.handleProviderCallbackResponse("feishu", group);
      expect(result.replies[0]?.text).toContain("私聊");
      expect(harness.createTaskCalls).toHaveLength(0);
      expect(harness.sendPromptCalls).toHaveLength(0);
    } finally {
      harness.service.disposeAll();
      globalThis.fetch = originalFetch;
    }
  });
});
