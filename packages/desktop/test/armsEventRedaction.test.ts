import { describe, expect, it } from "vitest";
import { redactArmsEventBatch } from "../src/main/armsEventRedaction.js";

function clickEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "click",
    type: "click",
    name: "click on button: 重构 src/auth 的登录流程...",
    target_name: "div[1]/div[3]/button[2]",
    duration: 12,
    snapshots: JSON.stringify({
      id: "task-item-8",
      className: "task-list-item selected",
      src: "file:///Users/alice/project/preview.png",
    }),
    ...overrides,
  };
}

describe("redactArmsEventBatch - click", () => {
  it("截掉 name 里的元素文本，只保留 tag 前缀", () => {
    const [event] = redactArmsEventBatch([clickEvent()]);
    expect(event!.name).toBe("click on button");
  });

  it("保留 input 的 type 前缀，便于区分控件", () => {
    const [event] = redactArmsEventBatch([
      clickEvent({ name: "click on checkbox-input: 启用自动提交..." }),
    ]);
    expect(event!.name).toBe("click on checkbox-input");
  });

  it("删除 snapshots，避免 href/src 带出本机路径", () => {
    const [event] = redactArmsEventBatch([clickEvent()]);
    expect(event!.snapshots).toBeUndefined();
  });

  it("保留 target_name 与耗时等结构化字段", () => {
    const [event] = redactArmsEventBatch([clickEvent()]);
    expect(event!.target_name).toBe("div[1]/div[3]/button[2]");
    expect(event!.duration).toBe(12);
  });

  it("没有文本后缀的 name 保持原样", () => {
    const [event] = redactArmsEventBatch([clickEvent({ name: "click on button" })]);
    expect(event!.name).toBe("click on button");
  });

  it("name 不是预期形态时整体丢弃为固定桶，不原样透传", () => {
    const [event] = redactArmsEventBatch([clickEvent({ name: "用户自定义标题：机密项目" })]);
    expect(event!.name).toBe("click");
  });
});

describe("redactArmsEventBatch - exception", () => {
  it("脱敏 message 里的绝对路径与邮箱", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "error",
        message: "ENOENT open '/Users/alice/work/secret-project/src/a.ts' for bob@example.com",
      },
    ]);
    expect(event!.message).not.toContain("alice");
    expect(event!.message).not.toContain("secret-project");
    expect(event!.message).not.toContain("bob@example.com");
  });

  it("脱敏 stack 中的 file:// 路径", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "error",
        stack: "at render (file:///Users/carol/app/index.js:10:5)",
      },
    ]);
    expect(event!.stack).not.toContain("carol");
  });

  it("脱敏 file 字段里的 Windows 安装目录，不带出本机用户名", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "error",
        source: "uncaughtException",
        message: "boom",
        file: "file:///C:/Users/erin/AppData/Local/Programs/ZCode/resources/app.asar/dist/renderer/assets/index-9f3a.js",
        line: 1,
        column: 2345,
      },
    ]);
    expect(String(event!.file)).not.toContain("erin");
    expect(event!.line).toBe(1);
    expect(event!.column).toBe(2345);
  });

  it("脱敏 whiteScreen 的 snapshots 文本", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "blank",
        snapshots: JSON.stringify({ url: "file:///Users/dave/app/index.html", when: 1 }),
      },
    ]);
    expect(String(event!.snapshots)).not.toContain("dave");
  });

  it("不改写原生 crashReporter dump 事件的 binary_images 判定字段", () => {
    const binaryImages = [{ name: "zcode" }];
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "crash",
        source: "crashReporter",
        message: "EXC_BAD_ACCESS",
        binary_images: binaryImages,
      },
    ]);
    expect(event!.binary_images).toBe(binaryImages);
  });

  it("普通诊断消息不被改写", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "exception",
        type: "error",
        message: "Cannot read properties of undefined (reading 'id')",
      },
    ]);
    expect(event!.message).toBe("Cannot read properties of undefined (reading 'id')");
  });
});

describe("redactArmsEventBatch - api / resource", () => {
  it("丢弃 url 的 query 与 fragment", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "resource",
        type: "api",
        url: "https://zcode.z.ai/api/v1/event/report?state=abc123#x",
        name: "https://zcode.z.ai/api/v1/event/report?state=abc123",
      },
    ]);
    expect(event!.url).toBe("https://zcode.z.ai/api/v1/event/report");
    expect(event!.name).toBe("https://zcode.z.ai/api/v1/event/report");
  });

  it("归一化路由里的 UUID 身份段", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "resource",
        type: "api",
        url: "https://zcode.z.ai/api/v1/tasks/0f8fad5b-d9cb-469f-a165-70867728950e/messages",
      },
    ]);
    expect(event!.url).toBe("https://zcode.z.ai/api/v1/tasks/{segment}/messages");
  });

  it("脱敏 api 事件的错误 message", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "resource",
        type: "api",
        url: "https://zcode.z.ai/api/v1/ping",
        message: "connect ECONNREFUSED for /Users/erin/.zcode/socket",
      },
    ]);
    expect(event!.message).not.toContain("erin");
  });

  it("本地静态资源归一为 local_file", () => {
    const [event] = redactArmsEventBatch([
      {
        event_type: "resource",
        type: "img",
        url: "file:///Users/frank/app/logo.png",
      },
    ]);
    expect(event!.url).toBe("local_file");
  });
});

describe("redactArmsEventBatch - 不影响其他事件", () => {
  it("longTask 的归因摘要 properties 保持不变", () => {
    const properties = { loaf_top_invoker_type: "user-callback", loaf_top_share_pct: 62 };
    const [event] = redactArmsEventBatch([{ event_type: "longTask", duration: 120, properties }]);
    expect(event!.properties).toBe(properties);
  });

  it("自定义事件（perf_*）不被本批次改写", () => {
    const input = {
      event_type: "custom",
      name: "perf_agent_crash",
      properties: { error_message: "<workspace>/src/a.ts failed" },
    };
    const [event] = redactArmsEventBatch([input]);
    expect(event!.properties).toEqual({ error_message: "<workspace>/src/a.ts failed" });
  });

  it("保持批次顺序与条数，空批次安全", () => {
    expect(redactArmsEventBatch([])).toEqual([]);
    const events = redactArmsEventBatch([
      { event_type: "view", type: "perf" },
      clickEvent(),
      { event_type: "exception", type: "error", message: "boom" },
    ]);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("perf");
    expect(events[1]!.name).toBe("click on button");
    expect(events[2]!.message).toBe("boom");
  });
});
