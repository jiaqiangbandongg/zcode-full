import { classifyConversationShareError } from "@zcode/shared";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSelectionDock } from "@/v4/ConversationShareSelectionDock.js";
import {
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
} from "@/lib/conversationShareError.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("kind") ?? "invalid_contract";
const codes: Record<string, number> = {
  safety_check_rejected: 3216,
  safety_check_unavailable: 3217,
  service_unavailable: 2001,
  invalid_conversation: 3205,
  expired: 3212,
};
const code = codes[scenario];
const status =
  scenario === "authentication_required"
    ? 401
    : scenario === "invalid_contract"
      ? 405
      : scenario === "network"
        ? 200
        : scenario === "expired"
          ? 410
          : scenario.includes("unavailable")
            ? 503
            : 422;
const kind = scenario === "network" ? scenario : classifyConversationShareError(status, code);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
function Fixture() {
  const [attempts, setAttempts] = useState(0);
  if (params.get("surface") === "preflight")
    return (
      <main className="p-4">
        <output data-testid="attempts">{attempts}</output>
        <ConversationShareSelectionDock
          selectedCount={3}
          totalCount={3}
          onCancel={() => {}}
          onNext={() => {}}
          onSelectAll={() => {}}
          onDeselectAll={() => {}}
          onRetryPreflight={() => setAttempts((value) => value + 1)}
          preflight={{
            status: "ready",
            revision: 1,
            logEpoch: "test",
            capabilitiesFingerprint: "test",
            blockingIssues: [
              { code: resolveConversationShareFallbackIssueCode({ kind }), scope: "transport" },
            ],
            skippableWarnings: [],
            deferredIssues: [],
            supportedArtifactTypes: [],
            turnResults: [],
          }}
        />
      </main>
    );
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
            status,
          }),
          status,
          code,
          rejection:
            kind === "invalid_conversation"
              ? { rule: "field_type", path: "rows[0].state", row_index: 0, field: "state" }
              : undefined,
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
