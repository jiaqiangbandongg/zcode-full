import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { resolveConversationSharePublishErrorMessageId } from "@/lib/conversationShareError.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") ?? "invalid_contract";
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
function Fixture() {
  const [attempts, setAttempts] = useState(0);
  return (
    <main className="p-4">
      <output data-testid="attempts">{attempts}</output>
      <ConversationShareConfirmationDock
        selectedCount={9}
        totalCount={9}
        progressPhase="checking"
        error={{
          issueCount: 1,
          issues: [{ code: "unknown", scope: "transport", phase: "checking" }],
          messageId: resolveConversationSharePublishErrorMessageId({
            kind,
            status: kind === "invalid_contract" ? 405 : 200,
          }),
          status: kind === "invalid_contract" ? 405 : 200,
          requestId: "server-request-33",
          clientRequestId: "client-request-33",
          operationId: "share-operation-33",
        }}
        onCancel={() => {}}
        onBack={() => {}}
        onConfirm={() => setAttempts(attempts + 1)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <Fixture />
  </ZCodeIntlProvider>,
);
