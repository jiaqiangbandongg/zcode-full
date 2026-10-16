export async function saveProviderModelMetadataDialog(label: string) {
  // 修复原因：模型 ID 改变后会 debounce 查询 catalog 的最大输出 Token，查询期间
  // 保存按钮按产品合同禁用。旧 case 只判断按钮存在就 click，disabled click 实际
  // 无效，随后把 provider 前置失败误报成具体模型或 Fork 等业务失败。
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const saveButton = Array.from(
          dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => {
          const text = button.innerText.replace(/\s+/g, " ").trim();
          return text === "保存" || text.startsWith("Save");
        });
        if (!saveButton || saveButton.disabled || dialog?.querySelector('[role="status"]')) {
          return false;
        }
        saveButton.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: `新增 ${label} 模型 metadata 保存按钮没有结束 catalog 查询并进入可点击状态`,
    },
  );
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector<HTMLElement>('[role="dialog"]')),
    {
      timeout: 10000,
      timeoutMsg: `新增 ${label} 模型 metadata 弹窗保存后没有关闭`,
    },
  );
}
