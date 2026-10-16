import { expect, it } from "vitest";
import { parseClientConfigSnapshot } from "../src/clientConfig.js";

it("有效的空响应撤销公开配置，未知字段不会透传", () => {
  expect(parseClientConfigSnapshot({ code: 0, data: null })).toEqual({
    pluginStoreOrder: null,
    zsrcUrl: null,
  });
  expect(
    parseClientConfigSnapshot({ code: 0, data: { configs: { privateField: "not public" } } }),
  ).toEqual({ pluginStoreOrder: null, zsrcUrl: null });
});

it("严格校验 envelope 并隔离坏的模式字段", () => {
  expect(() => parseClientConfigSnapshot({ code: 1001 })).toThrow(
    "Invalid public client config response",
  );
  expect(() => parseClientConfigSnapshot({ data: { configs: {} } })).toThrow();
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          pluginStoreOrder: {
            code: { categoryOrder: 3 },
            work: { categoryOrder: ["finance"] },
          },
        },
      },
    }),
  ).toEqual({ pluginStoreOrder: { work: { categoryOrder: ["finance"] } }, zsrcUrl: null });
});

it("读取公开漏洞入口，裁剪空白且不透传其它 zsrc 字段", () => {
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          zsrc: { url: "  https://security.example.test/report  ", privateField: "secret" },
        },
      },
    }),
  ).toEqual({ pluginStoreOrder: null, zsrcUrl: "https://security.example.test/report" });
});

it.each([
  undefined,
  null,
  {},
  { url: "" },
  { url: "   " },
  { url: 42 },
  { url: "/relative" },
  { url: "javascript:alert(1)" },
  { url: "file:///tmp/test" },
  { url: "https://" },
  "https://security.example.test",
])("坏的 zsrc 配置隐藏入口且不影响排序：%j", (zsrc) => {
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          zsrc,
          pluginStoreOrder: { work: { categoryOrder: ["finance"] } },
        },
      },
    }),
  ).toEqual({ pluginStoreOrder: { work: { categoryOrder: ["finance"] } }, zsrcUrl: null });
});

it("漏洞地址支持带空白的大小写混合 HTTP(S) scheme", () => {
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          zsrc: { url: "  HtTpS://security.example.test/report  " },
        },
      },
    }).zsrcUrl,
  ).toBe("HtTpS://security.example.test/report");
});
