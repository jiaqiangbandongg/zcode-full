import { TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { sel } from "./selectors.js";

// 新隔离 profile 的职业引导会覆盖工作区；通过真实 UI 完成，不伪造业务记录。
export async function skipOccupationOnboardingIfPresent() {
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="onboarding-page"]').isExisting()) ||
      (await $(sel(TID_TASK_SETTINGS_BUTTON)).isExisting()),
    { timeout: 30000 },
  );
  // 新隔离 profile 可能进入职业引导，按真实 UI 跳过三步，不改全局测试夹具。
  for (
    let step = 0;
    step < 3 && (await $('[data-testid="onboarding-page"]').isExisting());
    step++
  ) {
    const skip = $('//button[normalize-space(.)="Skip" or normalize-space(.)="跳过"]');
    await skip.waitForClickable({ timeout: 15000 });
    await skip.click();
  }
  await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15000 });
}

// 用产品支持的 Escape 退出引导（与“退出引导”按钮同一 closeOnboarding 路径，且不依赖界面语言）：
// 只持久化 dismissed 决策，不像“跳过”那样把 memoryEnabled 等偏好落成保守默认值，
// 供通用工作区就绪等待使用。
export async function dismissOccupationOnboarding() {
  await browser.keys("Escape");
}
