import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";
import { ZCODE_CLIENT_SCENES_URL } from "../src/providers/api/apiEndpoints.js";
import { createClientScenesService } from "../src/client-scenes/clientScenesService.js";

describe("ClientScenesService", () => {
  it("通过统一 ApiClient 读取 client scenes envelope", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "",
            data: [
              {
                namespace: "zcode",
                scene: "ai-slides",
                options: {
                  template: {
                    id: "template",
                    type: "template",
                    contents: { en: "Template", cn: "模板" },
                    prompts: { en: "Create slides", cn: "制作幻灯片" },
                    items: [
                      {
                        id: "business",
                        type: "template",
                        contents: { en: "Business", cn: "商务" },
                        descs: { en: "Business deck", cn: "商务演示" },
                        labels: { en: "Recommended", cn: "推荐" },
                        on_finish: "open_presentation",
                        img: null,
                        imgs: { cn: "https://example.com/cn.png" },
                        share_urls: {},
                      },
                    ],
                    refer: "",
                    cascades: {},
                  },
                },
                created_at: 1,
                updated_at: 2,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const service = createClientScenesService({
      apiClient: { request } as ApiClient,
    });

    await expect(service.list()).resolves.toEqual({
      code: 0,
      msg: "",
      data: [
        expect.objectContaining({
          namespace: "zcode",
          scene: "ai-slides",
          created_at: 1,
          updated_at: 2,
        }),
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(ZCODE_CLIENT_SCENES_URL, {
      method: "GET",
    });
  });
});
