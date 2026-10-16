import {
  createRecordingFeishuFetch,
  type RecordedRequest,
} from "../bots/helpers/bots-service-harness.js";

/** 只替代平台边界，任务、协议、工具与 Host 不做 stub。 */
export function installBotPlatformFixture() {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const record = createRecordingFeishuFetch(requests);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (!url.startsWith("https://open.feishu.cn/"))
      throw new Error(`Unexpected platform request: ${url}`);
    const special = (payload: unknown) => {
      requests.push({ url, method });
      return Response.json({ code: 0, data: payload });
    };
    if (url.endsWith("/bot/v3/info"))
      return Response.json({ code: 0, bot: { open_id: "ou_current_bot" } });
    if (url.includes("/im/v1/chats/")) return special({ name: "Isolated topic group" });
    if (method === "GET" && url.includes("/im/v1/messages?"))
      return special({ items: [...messages].reverse(), has_more: false });
    if (url.includes("/resources/")) {
      requests.push({ url, method });
      return new Response("E2E_ARCHIVE_FILE_CONTENT", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (method === "GET" && /\/im\/v1\/messages\/[^/?]+$/.test(url)) {
      return special({ items: messages.filter((m) => url.endsWith(`/${m.message_id}`)) });
    }
    return record(input, init);
  };
  return {
    requests,
    add(id: string, text: string, kind = "text") {
      messages.push({
        message_id: id,
        chat_id: "oc_worker",
        thread_id: "omt_worker",
        msg_type: kind,
        sender: { id: "ou_e2e_user", sender_type: "user" },
        create_time: String(messages.length + 1),
        body: {
          content: JSON.stringify(
            kind === "file" ? { file_key: "file_e2e", file_name: "archive.txt" } : { text },
          ),
        },
      });
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
