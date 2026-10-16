import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_PLAN_FIRST_MODEL,
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
  seedPersistedModelSelection,
  waitForSelectedModel,
} from "./model-provider-restart.js";
import { skipOccupationOnboardingIfPresent } from "./occupation-onboarding.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "./v4-conversation.js";

interface HighspeedEntranceProbe {
  observer: MutationObserver;
  state: { diffusionMounted: boolean };
}

interface HighspeedComposerProbe {
  observer: MutationObserver;
  state: { highspeedSeen: boolean };
}

export interface HighspeedEntranceSnapshot {
  /** 探针启动后扩散 Canvas 是否挂载过；探针缺失时为 null，避免否定断言空转通过。 */
  diffusionMounted: boolean | null;
  entrance: string | null;
  modelIndicatorVisible: boolean;
  phase: string | null;
}

// Bug 根因：Built-in Provider Config（revision 31）中 Team Coding Plan 与 BigModel 加速卡的
// builtinModelIds 都只剩 GLM-5.3 / GLM-5.3-Flash，继续 seed GLM-5.2 会被判为目录外模型，
// toolbar 回落到首个模型，waitForSelectedModel 在抽卡前就失败。改用两者目录共有的 GLM-5.3。
const HIGHSPEED_E2E_MODEL = E2E_PLAN_FIRST_MODEL;

declare global {
  interface Window {
    __zcodeHighspeedEntranceProbe?: HighspeedEntranceProbe;
    __zcodeHighspeedComposerProbe?: HighspeedComposerProbe;
  }
}

/**
 * Highspeed 抽卡 case 的共用准备：Coding Plan 凭据、Team scope、会话模型与 Host Mock 场景
 * （场景按 spec 文件注入，见 highspeed-mock-env.ts）。三个 case 走同一条准备链路，
 * `hit-fast` case 因此同时是资格链路的正向对照，未抽中类 case 的否定断言不会空转通过。
 */
export async function prepareHighspeedDrawWorkspace() {
  // Bug 根因：职业引导按“本机是否已有 Task”判定首跑，而每个 spec 的隔离 HOME 都没有 Task，
  // 引导会覆盖工作区，prepareV4ConversationE2E 等不到主界面直接失败，Highspeed 断言一条都没执行。
  // 按真实 UI 跳过引导（与其他 case 同一 helper），不伪造引导记录。
  await skipOccupationOnboardingIfPresent();
  await prepareV4ConversationE2E({ skipProvider: true });
  await seedBigModelOAuthCredential();
  // Provider 重构后连接方式按 family 记录结构化 selection（不再是 `coding-plan:<id>` 字符串键），
  // 且 E2E_BIGMODEL_PLAN_PROVIDER_ID 就是 Team Coding Plan，Team scope 必须一并 seed，
  // 否则加速卡请求期解析不到账号访问上下文。
  await seedBigModelConnectionSelection({
    kind: "team-coding-plan",
    productId: "product-team-a",
    organizationId: "org-team-a",
    projectId: "proj-team-a",
  });
  // Bug 根因：Team Coding Plan 自 2026-09-10 起官方请求链路只接受 HTTPS Endpoint。旧实现把
  // Provider 改写成 HTTP Mock Endpoint，每轮都在 model creation 阶段失败，turn 失败、timeline
  // 为空。保留内建 HTTPS Endpoint，由 wdio 的 Coding Plan 数据面代理回放。
  await seedPersistedModelSelection({
    modelId: HIGHSPEED_E2E_MODEL,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: "medium",
  });

  await restartIntoWorkspace();
  await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, HIGHSPEED_E2E_MODEL);
}

/**
 * 发送一轮并等到回复落入 timeline、pane 退出运行态。
 * prompt 不得包含 replyToken：timelineText 含用户消息，否则发送瞬间（turn 尚未进入运行态、
 * canStop 仍为 false）就会误判完成，下一轮会被当成 busy 输入排进队列。
 */
export async function sendHighspeedTurnAndWaitCompleted(prompt: string, replyToken: string) {
  if (prompt.includes(replyToken)) {
    throw new Error(`Highspeed turn prompt 不能包含回复标记 ${replyToken}`);
  }
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(replyToken);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop && snapshot.timelineText.includes(replyToken),
    `Highspeed mock turn 完成后 pane 仍处于运行态: ${replyToken}`,
    90000,
  );
}

export async function waitForHighspeedComposer(timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => Boolean(document.querySelector('[data-highspeed-composer="true"]'))),
    { timeout: 30000, timeoutMsg },
  );
}

export async function waitForHighspeedComposerCleared(timeoutMsg: string) {
  await browser.waitUntil(
    async () => browser.execute(() => !document.querySelector('[data-highspeed-composer="true"]')),
    { timeout: 30000, timeoutMsg },
  );
}

/** 从此刻起记录扩散 Canvas 是否挂载过；按新增节点判定，挂载后很快卸载也能记到。 */
export async function startHighspeedEntranceProbe() {
  await browser.execute(() => {
    window.__zcodeHighspeedEntranceProbe?.observer.disconnect();
    const state = { diffusionMounted: false };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches('[data-testid="highspeed-diffusion-canvas"]') ||
              node.querySelector('[data-testid="highspeed-diffusion-canvas"]') !== null)
          ) {
            state.diffusionMounted = true;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__zcodeHighspeedEntranceProbe = { observer, state };
  });
}

/** 停止探针并读取入场快照：入场方式、背景阶段、模型标识是否已呈现，以及期间扩散 Canvas 是否挂载过。 */
export function takeHighspeedEntranceProbe(): Promise<HighspeedEntranceSnapshot> {
  return browser.execute(() => {
    const probe = window.__zcodeHighspeedEntranceProbe;
    probe?.observer.disconnect();
    delete window.__zcodeHighspeedEntranceProbe;
    const surface = document.querySelector<HTMLElement>('[data-highspeed-composer="true"]');
    return {
      diffusionMounted: probe ? probe.state.diffusionMounted : null,
      entrance: surface?.getAttribute("data-highspeed-entrance") ?? null,
      modelIndicatorVisible:
        document.querySelector('[data-highspeed-model-indicator="true"]') !== null,
      phase:
        surface
          ?.querySelector('[data-testid="highspeed-composer-background"]')
          ?.getAttribute("data-phase") ?? null,
    };
  });
}

/**
 * 从此刻起记录输入框是否进入过 Highspeed：同时监听节点新增与 `data-highspeed-composer`
 * 属性翻转，进入后很快退出也能记到，避免只在收尾时采样漏掉中途闪现。
 */
export async function startHighspeedComposerProbe() {
  await browser.execute(() => {
    window.__zcodeHighspeedComposerProbe?.observer.disconnect();
    const state = {
      highspeedSeen: document.querySelector('[data-highspeed-composer="true"]') !== null,
    };
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-highspeed-composer="true"]')) state.highspeedSeen = true;
    });
    observer.observe(document.body, {
      attributeFilter: ["data-highspeed-composer"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.__zcodeHighspeedComposerProbe = { observer, state };
  });
}

/** 停止探针；探针缺失时返回 null，调用方用 `toBe(false)` 断言可避免否定断言空转通过。 */
export function takeHighspeedComposerProbe(): Promise<boolean | null> {
  return browser.execute(() => {
    const probe = window.__zcodeHighspeedComposerProbe;
    probe?.observer.disconnect();
    delete window.__zcodeHighspeedComposerProbe;
    return probe ? probe.state.highspeedSeen : null;
  });
}

export async function waitForHighspeedStatusTag(timeoutMsg: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(() => Boolean(document.querySelector('[data-highspeed-status-tag="true"]'))),
    { timeout: 30000, timeoutMsg },
  );
}

/** Highspeed 标识按 turn 分组渲染，数量即已加速的 turn 数。 */
export function countHighspeedStatusTags(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-highspeed-status-tag="true"]').length,
  );
}
