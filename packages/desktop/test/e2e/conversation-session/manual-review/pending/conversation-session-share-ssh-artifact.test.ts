import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  connectSSHWorkspace,
  readSSHRuntimeConfig,
  runSSHCommand,
} from "../../../helpers/ssh-remote-p0.js";
import {
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
} from "../../../helpers/conversation-session.js";

const CASE_MARKER = "E2E_CONVERSATION_SHARE_SSH_ARTIFACT_V1";

describe(`${CASE_MARKER}: Desktop SSH 产物分享`, () => {
  const config = readSSHRuntimeConfig(CASE_MARKER);
  const workspacePath = `${config.workspacePaths[0]}/zcode-share-${Date.now()}`;

  after(async () => {
    await runSSHCommand(config, `rm -rf -- '${workspacePath}'`).catch(() => undefined);
    await clearAppData();
  });

  it("SHARE18/SHARE-E2E-02 SSH trusted attachment 组合远端 Rows/File 与本地 JWT/API", async function () {
    this.timeout(240_000);
    await runSSHCommand(config, `mkdir -p -- '${workspacePath}'`);
    await connectSSHWorkspace({ caseMarker: CASE_MARKER, config, workspacePath });
    await sendPrompt(
      `${CASE_MARKER}: use Bash to create report.html in the workspace, then reply exactly share-ssh-ready`,
    );
    await waitForAssistantMessageContaining("share-ssh-ready");
    await waitForChatState(
      (snapshot) => snapshot.state === "idle",
      "SSH 分享前会话没有进入终态",
      120_000,
    );

    const shareButton = await $("[data-testid=conversation-share-trigger]");
    await shareButton.waitForClickable();
    await shareButton.click();
    const nextButton = await $("[data-testid=conversation-share-next]");
    await nextButton.waitForClickable();
    await nextButton.click();
    const publishButton = await $("[data-testid=conversation-share-confirm]");
    await publishButton.waitForClickable();
    await publishButton.click();
    const disclosure = await $("[data-testid=conversation-share-disclosure-confirm]");
    await disclosure.waitForClickable();
    await disclosure.click();
    await (
      await $("[data-testid=conversation-share-confirmation-dock]")
    ).waitForDisplayed({
      timeout: 120_000,
    });
  });
});
