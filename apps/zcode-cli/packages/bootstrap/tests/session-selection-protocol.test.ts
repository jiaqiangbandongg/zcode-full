import { describe, expect, it, vi } from "vitest";
import { zcodeProtocolMethods, type ZCodeProtocolMessage } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

async function request(server: ZCodeProtocolAgentServer, method: string, params: unknown) {
  const response = await server.handleMessage({ id: 1, method, params } as ZCodeProtocolMessage);
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}

describe("Session 原选择与输入协议", () => {
  it("完整配置命令保留档位，Session read 不用候选名单过滤原选择", async () => {
    let app!: ReturnType<typeof createFakeApp>;
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => (app = createFakeApp(options)),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const setModel = vi.spyOn(app, "setModel");
    const selection = {
      providerId: "glm",
      modelId: "glm-4-air",
      options: { reasoningLevel: "deep" },
    };
    const result = await request(server, zcodeProtocolMethods.sessionSetModel, {
      sessionId: app.sessionId,
      model: selection,
    });
    expect(setModel).toHaveBeenCalledWith(selection);
    expect(result).toMatchObject({ settings: { model: { current: selection } } });
    vi.spyOn(app.runtime, "getSessionModelSelection").mockReturnValue({
      ...selection,
      options: { reasoningLevel: "removed-level" },
    });
    expect(
      await request(server, zcodeProtocolMethods.sessionRead, { sessionId: app.sessionId }),
    ).toMatchObject({
      settings: {
        model: { current: { ...selection, options: { reasoningLevel: "removed-level" } } },
      },
    });
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });

  it("附件 Selection 进入同一个 input intent，执行凭据只进入非持久执行依赖", async () => {
    let app!: ReturnType<typeof createFakeApp>;
    let finish!: (value: never) => void;
    const completion = new Promise<never>((resolve) => {
      finish = resolve;
    });
    const sendInput = vi.fn(async () => ({
      kind: "started_turn" as const,
      turnId: "turn" as never,
      completion,
    }));
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp: (options) => (app = createFakeApp(options, { sendInput })),
    });
    await request(server, zcodeProtocolMethods.sessionCreate, {
      workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    });
    const selection = {
      providerId: "account:offpeak",
      modelId: "fixture-model",
      options: { reasoningLevel: "high" },
    };
    await request(server, zcodeProtocolMethods.sessionSend, {
      sessionId: app.sessionId,
      inputId: "attachment-input",
      content: "hi",
      attachments: [
        { kind: "image", filename: "a.png", mimeType: "image/png", dataBase64: "aGk=" },
      ],
      modelSelection: selection,
      modelExecution: {
        selectionScope: "execution",
        memoryExtraction: "skip",
        requestAuth: { headers: { "x-ticket": "fixture" } },
      },
    });
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalled());
    const [input, options] = sendInput.mock.calls[0]! as unknown as Parameters<
      typeof app.sendInput
    >;
    expect(input).toMatchObject({
      text: "hi",
      attachments: [expect.objectContaining({ type: "image" })],
    });
    expect(options).toMatchObject({
      inputId: "attachment-input",
      intent: { modelSelection: selection },
      modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
    });
    expect(JSON.stringify(options?.intent)).not.toContain("x-ticket");
    expect(
      await options?.modelExecution?.requestDependencies?.requestAuth?.source.resolve({} as never),
    ).toEqual({ headers: { "x-ticket": "fixture" } });
    expect(app.runtime.getSessionModelSelection()?.providerId).toBe("glm");
    try {
      const next = await server.handleMessage({
        id: 2,
        method: zcodeProtocolMethods.sessionSend,
        params: { sessionId: app.sessionId, content: "next" },
      });
      expect(next).toMatchObject({ error: { code: -32010 } });
      expect(sendInput).toHaveBeenCalledTimes(1);
    } finally {
      finish({} as never);
    }
    await request(server, zcodeProtocolMethods.sessionClose, { sessionId: app.sessionId });
  });
});
