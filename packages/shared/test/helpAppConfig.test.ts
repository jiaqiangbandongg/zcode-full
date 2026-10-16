import { describe, expect, it, vi } from "vitest";
import { createHelpAppConfigReader, resolveHelpAppConfig } from "../src/helpAppConfig.js";

const envelope = (feedbackUrl: unknown) => ({ code: 0, data: { configs: { feedbackUrl } } });
const local = {
  community_urls: { "zh-CN": "https://local.cn", "en-US": "https://local.en" },
  feedback_url: "https://local.feedback",
  feedback_use_external_form: true,
};

describe("help app config", () => {
  it("按字段和语言回退，远端 false 覆盖本地 true", () => {
    expect(
      resolveHelpAppConfig(
        { community_urls: { "zh-CN": "https://remote.cn" }, feedback_use_external_form: false },
        local,
      ),
    ).toEqual({
      community_urls: { "zh-CN": "https://remote.cn", "en-US": "https://local.en" },
      feedback_url: "https://local.feedback",
      feedback_use_external_form: false,
    });
  });
  it("有效 envelope、no-store、并发合并、TTL 和 endpoint 隔离", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json(envelope({ feedback_url: "https://remote.feedback" })),
      );
    const read = createHelpAppConfigReader({ fetchImpl, now: () => now });
    const [a, b] = await Promise.all([read("https://a/configs"), read("https://a/configs")]);
    expect(a).toEqual(b);
    expect(a.feedback_url).toBe("https://remote.feedback");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
    await read("https://a/configs");
    await read("https://b/configs");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = 3_600_001;
    await read("https://a/configs");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([{}, { code: 1, data: { configs: { feedbackUrl: {} } } }, envelope(null)])(
    "无效响应不进入缓存 %j",
    async (body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      const read = createHelpAppConfigReader({ fetchImpl });
      await expect(read("https://a/configs")).rejects.toThrow();
      await expect(read("https://a/configs")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
  it.each([new Response("bad", { status: 503 }), new Response("not json")])(
    "HTTP 和 JSON 错误不缓存",
    async (response) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response.clone());
      const read = createHelpAppConfigReader({ fetchImpl });
      await expect(read("https://a/configs")).rejects.toThrow();
      await expect(read("https://a/configs")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

it("超时信号传递到网络层，失败后可重试", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  const read = createHelpAppConfigReader({ fetchImpl });
  await expect(read("https://a/configs")).rejects.toThrow("timeout");
  expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  fetchImpl.mockImplementation(async () =>
    Response.json(envelope({ feedback_url: "https://recovered" })),
  );
  expect((await read("https://a/configs")).feedback_url).toBe("https://recovered");
});

it("旧 endpoint 的迟到响应不覆盖新 endpoint", async () => {
  let finishOld!: (response: Response) => void;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url).includes("old"))
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    return Response.json(envelope({ feedback_url: "https://new" }));
  });
  const read = createHelpAppConfigReader({ fetchImpl });
  const old = read("https://old/configs");
  expect((await read("https://new/configs")).feedback_url).toBe("https://new");
  finishOld(Response.json(envelope({ feedback_url: "https://old" })));
  await old;
  expect((await read("https://new/configs")).feedback_url).toBe("https://new");
});
