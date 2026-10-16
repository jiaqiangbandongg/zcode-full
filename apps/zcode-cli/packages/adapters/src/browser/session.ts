import { randomUUID } from "node:crypto";
import type { BrowserContext, Dialog, Page, ViewportSize } from "playwright-core";
import type { BrowserTabSummary } from "@zcode/contracts";

export interface ManagedCdpTab {
  id: string;
  page: Page;
}

const DEFAULT_VIEWPORT: ViewportSize = { width: 1280, height: 720 };

export class ManagedCdpSession {
  readonly #dialogs = new Map<string, Dialog>();
  readonly #tabs = new Map<string, ManagedCdpTab>();
  #activeTabId: string | undefined;

  constructor(readonly context: BrowserContext) {
    for (const page of context.pages()) this.registerPage(page);
    context.on("page", (page) => this.registerPage(page));
  }

  get tabIds(): string[] {
    return [...this.#tabs.keys()];
  }

  get activeTabId(): string | undefined {
    return this.#activeTabId;
  }

  async createTab(): Promise<ManagedCdpTab> {
    const page = await this.context.newPage();
    const tab = this.tabForPage(page) ?? this.registerPage(page);
    this.#activeTabId = tab.id;
    await page.bringToFront();
    return tab;
  }

  async ensureTab(tabId?: string): Promise<ManagedCdpTab> {
    if (tabId) {
      const tab = this.#tabs.get(tabId);
      if (!tab || tab.page.isClosed()) throw new Error(`Browser tab '${tabId}' is unavailable`);
      return tab;
    }
    const active = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    if (active && !active.page.isClosed()) return active;
    const fallback = [...this.#tabs.values()].find((candidate) => !candidate.page.isClosed());
    return fallback ?? (await this.createTab());
  }

  async activateTab(tabId: string): Promise<ManagedCdpTab> {
    const tab = await this.ensureTab(tabId);
    this.#activeTabId = tab.id;
    await tab.page.bringToFront();
    return tab;
  }

  async closeTab(tabId?: string): Promise<void> {
    const tab = await this.ensureTab(tabId);
    this.#tabs.delete(tab.id);
    this.#dialogs.delete(tab.id);
    if (!tab.page.isClosed()) await tab.page.close({ runBeforeUnload: false });
    if (this.#activeTabId === tab.id) {
      this.#activeTabId = [...this.#tabs.keys()].at(-1);
    }
  }

  async listTabs(): Promise<BrowserTabSummary[]> {
    const summaries: BrowserTabSummary[] = [];
    for (const tab of this.#tabs.values()) {
      if (tab.page.isClosed()) continue;
      summaries.push({
        tabId: tab.id,
        url: tab.page.url(),
        title: await tab.page.title().catch(() => ""),
        viewport: tab.page.viewportSize() ?? DEFAULT_VIEWPORT,
        ...(tab.id === this.#activeTabId ? { active: true } : {}),
        lifecycle: "active",
      });
    }
    return summaries;
  }

  dialogFor(tabId: string): Dialog | undefined {
    return this.#dialogs.get(tabId);
  }

  clearDialog(tabId: string): void {
    this.#dialogs.delete(tabId);
  }

  async setViewport(tabId: string | undefined, viewport: ViewportSize | null): Promise<void> {
    const tab = await this.ensureTab(tabId);
    await tab.page.setViewportSize(viewport ?? DEFAULT_VIEWPORT);
  }

  async close(): Promise<void> {
    this.#dialogs.clear();
    this.#tabs.clear();
    if (!this.context.browser()?.isConnected()) return;
    await this.context.close().catch(() => undefined);
  }

  private registerPage(page: Page): ManagedCdpTab {
    const existing = this.tabForPage(page);
    if (existing) return existing;
    const tab = { id: `tab:${randomUUID()}`, page };
    this.#tabs.set(tab.id, tab);
    this.#activeTabId ??= tab.id;
    page.on("dialog", (dialog) => this.#dialogs.set(tab.id, dialog));
    page.on("close", () => {
      this.#tabs.delete(tab.id);
      this.#dialogs.delete(tab.id);
      if (this.#activeTabId === tab.id) this.#activeTabId = [...this.#tabs.keys()].at(-1);
    });
    return tab;
  }

  private tabForPage(page: Page): ManagedCdpTab | undefined {
    return [...this.#tabs.values()].find((candidate) => candidate.page === page);
  }
}
