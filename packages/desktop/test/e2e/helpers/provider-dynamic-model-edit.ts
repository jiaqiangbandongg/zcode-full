import { BUILTIN_MODEL_PROVIDER_IDS, TID_MODEL_PROVIDER_ADD_MODEL_BUTTON } from "@zcode/shared";
import { ModelConfig } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { clickTestIdByDom, getE2EAppDataPaths } from "./desktop-app.js";

/** Todo 88：只从账单 mock 提供成员，不能 seed Personal modelIds 让错误的静态校验侥幸通过。 */
export async function assertDynamicStartPlanModelEditing() {
  const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
  const modelId = "glm-5.3-flash";
  const modelRow = (id: string) => $(`[data-model-provider-model-id="${id}"]`);
  const editor = '[data-model-reasoning-level-editor="true"]';
  const context = '[data-model-settings-group="tokens"] input';
  const repository = new NodePersonalProviderConfigRepository({
    filePath: getE2EAppDataPaths().configFile,
    pollingIntervalMs: false,
  });
  async function open() {
    const edit = modelRow(modelId).$("button:has(svg.lucide-pencil)");
    await edit.waitForClickable({ timeout: 15000 });
    await edit.click();
    await $(editor).waitForExist({ timeout: 15000 });
  }
  async function close(action: "Save" | "Cancel") {
    const localLabel = action === "Save" ? "保存" : "取消";
    const button = await $('[data-model-settings-footer="true"]').$(
      `.//button[normalize-space(.)="${action}" or normalize-space(.)="${localLabel}"]`,
    );
    await button.click();
    await $(editor).waitForExist({ reverse: true, timeout: 15000 });
  }
  async function add(id: string) {
    await clickTestIdByDom(TID_MODEL_PROVIDER_ADD_MODEL_BUTTON);
    await $('[data-model-identity-row="true"] input').setValue(id);
    const save = $('[data-model-settings-footer="true"]').$(
      './/button[normalize-space(.)="Save" or normalize-space(.)="保存"]',
    );
    await save.waitForClickable({ timeout: 15000 });
    await save.click();
    await browser.waitUntil(
      async () =>
        (await repository.read()).providers.get(providerId)?.personalModelIds?.includes(id) ===
        true,
      { timeout: 15000, timeoutMsg: "首次添加 Account 模型未保存" },
    );
  }
  async function remove(id: string) {
    await modelRow(id).$("button:has(svg.lucide-trash-2)").click();
    await browser.waitUntil(
      async () =>
        !(await repository.read()).providers.get(providerId)?.personalModelIds?.includes(id),
      { timeout: 15000 },
    );
  }
  try {
    // 首次添加必须从无根覆盖开始，不能再靠先排序绕过创建缺陷。
    expect((await repository.read()).providers.has(providerId)).toBe(false);
    await add("glm-todo89-first");
    expect((await repository.read()).providers.get(providerId)?.builtinModelIds).toBeUndefined();
    await remove("glm-todo89-first");

    await open();
    await $(context).setValue("234567");
    // 外部配置刷新走真实文件监听；只改另一个模型，不能把被测输入值直接写进仓库。
    await repository.update((current) => ({
      ...current,
      models: current.models.setExact(
        providerId,
        "glm-5-turbo",
        new ModelConfig({ enabled: false }),
      ),
    }));
    await browser.waitUntil(
      async () =>
        (await modelRow("glm-5-turbo").$('[role="switch"]').getAttribute("aria-checked")) ===
        "false",
      { timeout: 15000 },
    );
    expect(await $(context).getValue()).toBe("234567");
    await $('[data-model-settings-footer="true"]')
      .$('.//button[normalize-space(.)="Save" or normalize-space(.)="保存"]')
      .click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.body.innerText)).includes("revision conflict"),
      { timeout: 15000 },
    );
    expect(await $(context).getValue()).toBe("234567");
    await close("Cancel");

    await open();
    expect(
      await $('[data-model-identity-row="true"] input').getAttribute("readonly"),
    ).not.toBeNull();
    await $(context).setValue("240000");
    await close("Save");
    await open();
    expect(await $(context).getValue()).toBe("240000");
    await close("Cancel");

    const source = modelRow("glm-5-turbo");
    const target = modelRow(modelId);
    await target.scrollIntoView({ block: "center" });
    const a = await source.getLocation();
    const b = await target.getLocation();
    const aSize = await source.getSize();
    const bSize = await target.getSize();
    const x = Math.round(a.x + aSize.width / 2);
    const y = Math.round(a.y + aSize.height / 2);
    await browser.performActions([
      {
        id: "dynamic-model-order",
        type: "pointer",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, x, y },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 120, x, y: y + 10 },
          {
            type: "pointerMove",
            duration: 260,
            x: Math.round(b.x + bSize.width / 2),
            y: Math.round(b.y + bSize.height - 4),
          },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(
      async () => {
        const personal = await repository.read();
        return (
          personal.providers.get(providerId)?.modelOrder?.join("/") === `${modelId}/glm-5-turbo`
        );
      },
      { timeout: 15000, timeoutMsg: "动态模型拖拽后顺序没有保存" },
    );
    const personal = await repository.read();
    expect(personal.providers.get(providerId)?.personalModelIds ?? []).toEqual([]);
    expect(personal.models.getExact(providerId, modelId)?.properties?.contextWindow).toBe(240000);
    await add("glm-todo89-last");
    expect((await repository.read()).providers.get(providerId)?.modelOrder).toEqual([
      modelId,
      "glm-5-turbo",
      "glm-todo89-last",
    ]);
    await remove("glm-todo89-last");
  } finally {
    repository.dispose();
  }
}
