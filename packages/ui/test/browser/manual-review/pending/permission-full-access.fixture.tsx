import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PermissionDialog } from "@/PermissionDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ZCodePermissionRequest } from "@zcode/shared";
import "@/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);
const request: ZCodePermissionRequest = {
  type: "permission_request",
  taskId: "s",
  traceId: "trace",
  requestId: "p",
  kind: "Bash",
  title: "Bash",
  description: "Run command",
  raw: {
    command:
      params.get("command") === "long"
        ? `printf "%s" "${"long/path/".repeat(160)}COMMAND_END"`
        : "ping -c 4 www.baidu.com",
  },
  freeText: true,
  options: [
    { optionId: "allowOnce", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
    {
      optionId: "allowAlways",
      kind: "allow_always",
      name: "Always allow in this project",
      response: {
        decision: "allow",
        permissionUpdates: [
          {
            type: "addRules",
            behavior: "allow",
            rules: [{ toolName: "Bash", ruleContent: "ping -c 4 www.baidu.com" }],
          },
        ],
      },
    },
    { optionId: "fullAccess", kind: "custom", name: "Full access", response: { decision: "deny" } },
    { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
  ],
};
function Fixture() {
  const [response, setResponse] = useState("");
  return (
    <main className="min-h-screen bg-background text-foreground p-3">
      <PermissionDialog
        request={request}
        isWebRemoteControl={innerWidth < 600}
        onRespond={(_id, option) => setResponse(option.optionId)}
      />
      <output data-testid="response">{response}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <Fixture />
  </ZCodeIntlProvider>,
);
