import { TID_LOGIN_TRIGGER } from "@zcode/shared";
import { DEFAULT_WORKSPACE, waitForDefaultWorkspaceReady } from "./desktop-app.js";
import { sel } from "./selectors.js";

const TID_CODING_PLAN_PURCHASE_PERSONAL_PLAN_BUTTON = "coding-plan-purchase-personal-plan-button";
const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";
const PERSONAL_PLAN_KEYS = ["glm-coding-lite", "glm-coding-pro", "glm-coding-max"] as const;

interface PersonalPlanButtonState {
  key: string;
  disabled: boolean;
  text: string;
}

export async function openBigModelCodingPlanPersonalUpgradePanel(
  beforeClick?: () => Promise<void>,
) {
  await openCodingPlanPersonalUpgradePanel({
    supplierKey: "custom:account:bigmodel-individual-coding-plan",
    beforeClick,
  });
}

export async function openZaiCodingPlanPersonalUpgradePanel() {
  await openCodingPlanPersonalUpgradePanel({
    supplierKey: "custom:account:zai-individual-coding-plan",
  });
}

async function openCodingPlanPersonalUpgradePanel({
  supplierKey,
  beforeClick,
}: {
  supplierKey: string;
  beforeClick?: () => Promise<void>;
}) {
  await waitForDefaultWorkspaceReady(30000);
  await selectCodingPlanRuntime(supplierKey);
  const profileTrigger = await $(sel(TID_LOGIN_TRIGGER));
  await profileTrigger.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "没有找到头像菜单入口",
  });
  await profileTrigger.click();
  await beforeClick?.();
  await clickSidebarCodingPlanUpgradeEntry();
}

async function selectCodingPlanRuntime(supplierKey: string) {
  await browser.execute(
    (workspacePath, selectedSupplierKey) => {
      const store = (
        window as Window & {
          __zcodeSessionStoreE2E?: {
            getState: () => {
              setModelSelectionResolution: (
                workspacePath: string,
                resolution: {
                  selectedSupplierKey: string;
                  isGhostSupplier: boolean;
                  supplierMismatchReason: string | null;
                },
              ) => void;
            };
          };
        }
      ).__zcodeSessionStoreE2E;
      store?.getState().setModelSelectionResolution(workspacePath, {
        selectedSupplierKey,
        isGhostSupplier: false,
        supplierMismatchReason: null,
      });
    },
    DEFAULT_WORKSPACE,
    supplierKey,
  );
}

export async function waitForPersonalPlanButtonsLabel(expectedLabels: readonly string[]) {
  await browser.waitUntil(
    async () => {
      const states = await readPersonalPlanButtonStates();
      return (
        states.length === PERSONAL_PLAN_KEYS.length &&
        states.every(
          (state) => state.disabled && expectedLabels.some((label) => state.text.includes(label)),
        )
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `个人套餐按钮没有显示预期文案: ${expectedLabels.join(" / ")}`,
    },
  );
}

export async function readPersonalPlanButtonStates() {
  await waitForPersonalPlanButtonsInDialog();
  return (await browser.execute(
    (prefix: string, keys: string[]) =>
      keys.map((key) => {
        const elements = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`[data-testid="${prefix}-${key}"]`),
        );
        // 修复原因：背景设置页和 sidebar 升级弹层会同时挂载同名购买按钮；
        // 弹层 DOM 在后面，E2E 必须读取最后一组，否则会误读背景页的 Select 状态。
        const element = elements.at(-1);
        return {
          key,
          disabled: element?.disabled ?? false,
          text: element?.innerText.replace(/\s+/g, " ").trim() ?? "",
        };
      }),
    TID_CODING_PLAN_PURCHASE_PERSONAL_PLAN_BUTTON,
    [...PERSONAL_PLAN_KEYS],
  )) as PersonalPlanButtonState[];
}

async function waitForPersonalPlanButtonsInDialog() {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (prefix: string, keys: string[]) => {
          return keys.every((key) =>
            Boolean(document.querySelector(`[data-testid="${prefix}-${key}"]`)),
          );
        },
        TID_CODING_PLAN_PURCHASE_PERSONAL_PLAN_BUTTON,
        [...PERSONAL_PLAN_KEYS],
      )) === true,
    {
      timeout: 30000,
      timeoutMsg: "升级弹窗没有出现个人套餐按钮",
    },
  );
}

async function clickSidebarCodingPlanUpgradeEntry() {
  let latestMenuItems: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = (await browser.execute((testIdValue) => {
        const byTestId = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === testIdValue,
        );
        if (byTestId) {
          byTestId.click();
          return { clicked: true, items: [] };
        }
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
        );
        const items = candidates.map((item) => item.innerText.replace(/\s+/g, " ").trim());
        const target = candidates.find((item) =>
          /^(升级|续期|Upgrade|Renew)$/iu.test(item.innerText.replace(/\s+/g, " ").trim()),
        );
        if (!target) {
          return { clicked: false, items };
        }
        target.click();
        return { clicked: true, items };
      }, TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON)) as {
        clicked: boolean;
        items: string[];
      };
      latestMenuItems = result.items;
      return result.clicked;
    },
    {
      timeout: 15000,
      timeoutMsg: `头像菜单没有出现 Coding Plan 升级入口，当前菜单项: ${latestMenuItems.join(" / ")}`,
    },
  );
}
