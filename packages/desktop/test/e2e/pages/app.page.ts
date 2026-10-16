import type { ChainablePromiseArray, ChainablePromiseElement } from "webdriverio";
import {
  TID_APP_HEADER,
  TID_LOCALE_TOGGLE,
  TID_THEME_TOGGLE,
  TID_LOGOUT_BUTTON,
  TID_TERMINAL_TOGGLE,
  TID_TERMINAL_CLOSE_BUTTON,
  TID_BROWSER_TOGGLE,
  TID_BROWSER_CLOSE_BUTTON,
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_PANE,
  TID_BROWSER_REFRESH_BUTTON,
  TID_PREVIEW_CLOSE_BUTTON,
  TID_PREVIEW_NEXT_BUTTON,
  TID_PREVIEW_PANE,
  TID_PREVIEW_PREV_BUTTON,
  TID_TERMINAL,
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_HOST_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_USERNAME_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_CONNECT_BUTTON,
  TID_SSH_CANCEL_BUTTON,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
  TID_WORKSPACE_LIST,
  TID_WORKSPACE_OPEN_BUTTON,
  TID_SIDEBAR,
  TID_CHAT_VIEW,
  TID_CHAT_MESSAGES,
  TID_CHAT_EMPTY,
  TID_CHAT_INPUT,
  TID_CHAT_SEND_BUTTON,
  TID_TASK_LIST,
  TID_TASK_NEW_BUTTON,
  TID_TASK_EMPTY,
  TID_WORKSPACE_HEADER,
  TID_WORKSPACE_TITLE,
  TID_WORKSPACE_PATH,
} from "@zcode/shared";
import { sel } from "../helpers/selectors.js";

class AppPage {
  // ── Header ──
  get header(): ChainablePromiseElement {
    return $(sel(TID_APP_HEADER));
  }
  get themeToggle(): ChainablePromiseElement {
    return $(sel(TID_THEME_TOGGLE));
  }
  get localeToggle(): ChainablePromiseElement {
    return $(sel(TID_LOCALE_TOGGLE));
  }
  get logoutButton(): ChainablePromiseElement {
    return $(sel(TID_LOGOUT_BUTTON));
  }

  // ── Tab Bar ──
  get tabBar(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_LIST));
  }
  get newTabButton(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_OPEN_BUTTON));
  }
  get workspaceList(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_LIST));
  }

  // ── Sidebar ──
  get sidebar(): ChainablePromiseElement {
    return $(sel(TID_SIDEBAR));
  }
  // Bugfix: 侧栏已经从旧版“Files / Tasks”双标签切成一体化结构，
  // 但部分 e2e 用例还在走旧命名。这里保留最小兼容映射，避免测试类型层继续引用失效属性。
  get sidebarFilesTab(): ChainablePromiseElement {
    return this.workspaceList;
  }
  get sidebarFilesContent(): ChainablePromiseElement {
    return this.workspaceList;
  }
  get sidebarTasksContent(): ChainablePromiseElement {
    return this.taskList;
  }
  // ── Workspace Header ──
  get workspaceHeader(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_HEADER));
  }
  get workspaceTitle(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_TITLE));
  }
  get workspacePath(): ChainablePromiseElement {
    return $(sel(TID_WORKSPACE_PATH));
  }
  get terminalToggle(): ChainablePromiseElement {
    return $(sel(TID_TERMINAL_TOGGLE));
  }
  get browserToggle(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_TOGGLE));
  }
  get terminal(): ChainablePromiseElement {
    return $(sel(TID_TERMINAL));
  }
  get terminalCloseButton(): ChainablePromiseElement {
    return $(sel(TID_TERMINAL_CLOSE_BUTTON));
  }

  // ── Chat View ──
  get chatView(): ChainablePromiseElement {
    return $(sel(TID_CHAT_VIEW));
  }
  get chatMessages(): ChainablePromiseElement {
    return $(sel(TID_CHAT_MESSAGES));
  }
  get userMessages(): ChainablePromiseArray {
    return $$(`${sel(TID_CHAT_MESSAGES)} .is-user`);
  }
  get assistantMessages(): ChainablePromiseArray {
    return $$(`${sel(TID_CHAT_MESSAGES)} .is-assistant`);
  }
  get chatEmpty(): ChainablePromiseElement {
    return $(sel(TID_CHAT_EMPTY));
  }
  get chatInput(): ChainablePromiseElement {
    return $(sel(TID_CHAT_INPUT));
  }
  get chatSendButton(): ChainablePromiseElement {
    return $(sel(TID_CHAT_SEND_BUTTON));
  }
  get scrollButton(): ChainablePromiseElement {
    return $(`${sel(TID_CHAT_MESSAGES)} button`);
  }

  // ── Task List ──
  get taskList(): ChainablePromiseElement {
    return $(sel(TID_TASK_LIST));
  }
  get taskNewButton(): ChainablePromiseElement {
    return $(sel(TID_TASK_NEW_BUTTON));
  }
  get taskEmpty(): ChainablePromiseElement {
    return $(sel(TID_TASK_EMPTY));
  }

  // ── Browser Pane ──
  get browserPane(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_PANE));
  }
  get browserCloseButton(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_CLOSE_BUTTON));
  }
  get browserAddressInput(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_ADDRESS_INPUT));
  }
  get browserBackButton(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_BACK_BUTTON));
  }
  get browserForwardButton(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_FORWARD_BUTTON));
  }
  get browserRefreshButton(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_REFRESH_BUTTON));
  }
  get browserDevtoolsButton(): ChainablePromiseElement {
    return $(sel(TID_BROWSER_DEVTOOLS_BUTTON));
  }
  get previewPane(): ChainablePromiseElement {
    return $(sel(TID_PREVIEW_PANE));
  }
  get previewCloseButton(): ChainablePromiseElement {
    return $(sel(TID_PREVIEW_CLOSE_BUTTON));
  }
  get previewPrevButton(): ChainablePromiseElement {
    return $(sel(TID_PREVIEW_PREV_BUTTON));
  }
  get previewNextButton(): ChainablePromiseElement {
    return $(sel(TID_PREVIEW_NEXT_BUTTON));
  }

  // ── SSH Dialog ──
  get sshConnectTrigger(): ChainablePromiseElement {
    return $(sel(TID_SSH_CONNECT_TRIGGER));
  }
  get sshDialog(): ChainablePromiseElement {
    return $(sel(TID_SSH_DIALOG));
  }
  get sshHostInput(): ChainablePromiseElement {
    return $(sel(TID_SSH_HOST_INPUT));
  }
  get sshPortInput(): ChainablePromiseElement {
    return $(sel(TID_SSH_PORT_INPUT));
  }
  get sshUsernameInput(): ChainablePromiseElement {
    return $(sel(TID_SSH_USERNAME_INPUT));
  }
  get sshPasswordInput(): ChainablePromiseElement {
    return $(sel(TID_SSH_PASSWORD_INPUT));
  }
  get sshPrivateKeyInput(): ChainablePromiseElement {
    return $(sel(TID_SSH_PRIVATE_KEY_INPUT));
  }
  get sshConnectButton(): ChainablePromiseElement {
    return $(sel(TID_SSH_CONNECT_BUTTON));
  }
  get sshCancelButton(): ChainablePromiseElement {
    return $(sel(TID_SSH_CANCEL_BUTTON));
  }
  get sshError(): ChainablePromiseElement {
    return $(sel(TID_SSH_ERROR));
  }
  get sshSuccess(): ChainablePromiseElement {
    return $(sel(TID_SSH_SUCCESS));
  }

  /** 打开 SSH 连接弹窗 */
  async openSSHDialog() {
    await this.sshConnectTrigger.click();
    await this.sshDialog.waitForDisplayed();
  }

  /** 切换主题 */
  async toggleTheme() {
    await this.themeToggle.click();
  }
}

export default new AppPage();
