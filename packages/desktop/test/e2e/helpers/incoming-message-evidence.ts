import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface WireMessage {
  role: string;
  content: unknown;
}
export type Presentation =
  | "user_steer"
  | "coordinator_input"
  | "coordinator_steer"
  | "subagent_reply_steer"
  | "subagent_reply"
  | "task_notification"
  | "task_notification_steer";

export function wireText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : ""))
    .join("\n");
}

/** 验证实际网络载荷；黄金样本独立于生产 formatter。 */
export async function assertIncomingMessage(
  request: unknown,
  input: {
    presentation: Presentation;
    marker: string;
    role: "user" | "system";
    body?: string;
    evidenceLabel?: string;
  },
) {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../../apps/zcode-cli/packages/core/tests/fixtures/runtime-input-presentation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { expected: Record<Presentation, string> };
  const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
  if (artifactDir) {
    const directory = join(artifactDir, "incoming-message-wire");
    await mkdir(directory, { recursive: true });
    const name = `${input.evidenceLabel ?? "default"}-${input.presentation}-${input.marker.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 96)}.json`;
    // 只保存实际 provider JSON body；不持久化网络凭据或 headers。
    await writeFile(join(directory, name), `${JSON.stringify(request, null, 2)}\n`, "utf8");
  }
  const messages = (request as { messages: WireMessage[] }).messages;
  assertWireIntegrity(request);
  const template = fixture.expected[input.presentation];
  const prefix = template.split("{body}")[0]!;
  const index = messages.findIndex(
    (message) =>
      wireText(message.content).includes(prefix) &&
      wireText(message.content).includes(input.marker),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const message = messages[index]!;
  const text = wireText(message.content);
  const body =
    input.body ??
    (input.presentation.startsWith("subagent")
      ? text.match(/<subagent-message>[\s\S]*?<\/subagent-message>/u)?.[0]
      : text.match(/<task-notification>[\s\S]*?<\/task-notification>/gu)?.join("\n\n"));
  expect(body).toBeDefined();
  const wrapped =
    input.role === "user" &&
    (input.presentation.endsWith("_steer") || input.presentation === "task_notification");
  // 独立校验 provider 表达；提取自 wire 的正文可能已转义，不能再次编码实体。
  const wireBody = wrapped ? body!.replace(/<(\/?system-reminder\b)/gi, "&lt;$1") : body!;
  const expected = template.replace("{body}", wireBody);
  expect(
    messages.reduce((count, item) => count + wireText(item.content).split(expected).length - 1, 0),
  ).toBe(1);
  expect(message.role).toBe(input.role);
  expect(text).toContain(expected);
  if (input.presentation !== "coordinator_input") {
    const expectedBlock = wrapped ? `<system-reminder>\n${expected}\n</system-reminder>` : expected;
    const blocks =
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "text").map((block) => block.text)
          : [];
    // 精确比较完整 block，防止正确模板前后夹入额外控制文案。
    expect(blocks).toContain(expectedBlock);
    if (wrapped) {
      const actualBlock = blocks.find(
        (block) => block.includes(prefix) && block.includes(input.marker),
      );
      expect(actualBlock?.match(/<\/?system-reminder\b/gi)).toHaveLength(2);
    }
  }

  // 只统计 text block，工具入参中的同名载荷不算第二份输入。
  expect(
    messages.reduce((count, item) => count + wireText(item.content).split(wireBody).length - 1, 0),
  ).toBe(1);
  if (input.role === "system") expect(text).not.toContain(`<system-reminder>\n${prefix}`);
  else if (wrapped) expect(text).toContain(`<system-reminder>\n${expected}\n</system-reminder>`);
  else expect(text).not.toContain(`<system-reminder>\n${expected}`);
  return { index, messages };
}

/** 系统中途消息不能拆开并行工具的结果批次，也不能泄漏内部来源字段。 */
export function assertWireIntegrity(request: unknown): void {
  const messages = (request as { messages: WireMessage[] }).messages;
  expect(JSON.stringify(request)).not.toMatch(
    /"(?:inputPresentation|steerContext|sourceEntries)"\s*:/u,
  );
  const pending = new Set<string>();
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const results = blocks.filter((block) => block.type === "tool_result");
    if (pending.size > 0) {
      expect(message.role).toBe("user");
      expect(results.map((block) => block.tool_use_id).sort()).toEqual([...pending].sort());
      pending.clear();
    } else {
      expect(results).toHaveLength(0);
    }
    for (const block of blocks) {
      if (block.type === "tool_use") pending.add(block.id);
    }
    expect(wireText(message.content).length > 0 || blocks.length > 0).toBe(true);
  }
  expect([...pending]).toHaveLength(0);
}

/** 既有后台生命周期用例共用全文断言；角色分支另由双能力时序矩阵固定验证。 */
export async function assertTaskNotificationContents(
  request: unknown,
  evidenceLabel: string,
): Promise<void> {
  const messages = (request as { messages: WireMessage[] }).messages;
  for (const [index, message] of messages.entries()) {
    const text = wireText(message.content);
    const bodies = text.match(/<task-notification>[\s\S]*?<\/task-notification>/gu);
    if (!bodies?.length) continue;
    expect(["user", "system"]).toContain(message.role);
    const body = bodies.join("\n\n");
    const marker = bodies[0]!.match(/<task-id>([^<]+)<\/task-id>/u)?.[1];
    expect(marker).toBeTruthy();
    // user 的中途降级与新轮通知现在使用相同包装，不能再根据标签推断消费时机。
    // 此处只验证全文；实际时序及角色仍由 BG25/BG36 双能力用例单独固定。
    const mid = message.role === "system";
    await assertIncomingMessage(request, {
      presentation: mid ? "task_notification_steer" : "task_notification",
      marker: marker!,
      body,
      role: message.role as "system" | "user",
      evidenceLabel: `${evidenceLabel}-${index}`,
    });
  }
}
