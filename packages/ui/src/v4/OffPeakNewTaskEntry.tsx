import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* New task 页闲时任务入口（Figma ⚫️ Z.ai - Zcode / node 5488-3978；spec §5「模板」/ D30-4 第二入口）。
   引导横幅「Use free run Idle-time task」+ Client Scenes 模板卡（预填创建表单，Customize=空白）。
   灰度未命中不渲染（D31）；横幅可关闭（本会话内，D28「关闭后下次登录/重启再开」→ session 级）。
   点击卡片：暂存预填草稿 → 打开 Automations 主视图（idle tab）创建表单消费草稿。
   入口位于草稿页底部固定区（距底 38px），模板恢复为桌面三列横排、窄屏单列；
   业务逻辑（灰度、Coding Plan 判定、Upgrade Toast、草稿预填、埋点）保持不变。 */
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { Megaphone, Moon, X } from "lucide-react";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import {
  appendLocalCustomizeTemplate,
  materializeOffPeakTemplateDraft,
  resolveOffPeakTemplateText,
  type OffPeakAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useOffPeakTaskStore, type OffPeakCreateDraft } from "@/store/offPeakTaskStore.js";
import { useMemo } from "react";

interface OffPeakNewTaskEntryProps {
  /** 打开 Automations 主视图（idle tab）；点击卡片前会先暂存预填草稿。 */
  onOpenAutomations?: () => void;
}

export function OffPeakNewTaskEntry({ onOpenAutomations }: OffPeakNewTaskEntryProps) {
  const { intl, locale } = useZCodeIntl();
  const { clientScenesService } = useServices();
  const { offPeak: remoteOffPeakTemplates } = useAutomationTemplates(clientScenesService);
  const offPeakTemplates = useMemo(
    () => appendLocalCustomizeTemplate(remoteOffPeakTemplates),
    [remoteOffPeakTemplates],
  );
  const { settings: sharedSettings } = useSettings();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const entryGate = useCodingPlanEntryGate();
  const grayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const dismissed = useOffPeakTaskStore((state) => state.newTaskBannerDismissed);
  const dismiss = useOffPeakTaskStore((state) => state.dismissNewTaskBanner);
  const setPendingCreateDraft = useOffPeakTaskStore((state) => state.setPendingCreateDraft);

  // 灰度未命中 / 用户已关闭 → 不渲染（D31 曝光门控 + D28 可关闭）。
  if (grayConfig?.enabled !== true || dismissed) return null;

  const entryPlanState = resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView);
  const codingPlanUnavailable =
    grayConfig.codingPlanActive === false ||
    (grayConfig.codingPlanActive === undefined &&
      providerSettingsView !== null &&
      entryPlanState.entryPlanStatus !== "coding_plan");

  const showCodingPlanRequiredToast = () => {
    toast(entryGate.label ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryGate.status === "loading"
          ? undefined
          : (entryGate.label ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction:
        entryGate.status === "error"
          ? entryGate.retry
          : () => {
              const providerId =
                sharedSettings?.providerFamilyDomain === "bigmodel"
                  ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
                  : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
              const eventText = intl.formatMessage({
                id: "settings.modelProvider.codingPlan.upgrade",
              });
              // 埋点缺失原因：闲时入口此前只传 providerId，购买面板无法建立来源明确的漏斗，
              // OAuth 前后也没有可延续的归因上下文。点击时冻结一次 context，由全局弹窗跨登录持有。
              codingPlanUpgradeDialog?.openCodingPlanUpgrade({
                providerId,
                initialAudience: "personal",
                funnelContext: createIdleTimeCodingPlanFunnelContext({
                  providerId,
                  eventText,
                  entryPlanState,
                }),
              });
            },
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  };

  const handleCardClick = (template: OffPeakAutomationTemplate) => {
    // Bug 原因：selected-connection 门禁把“未选 provider”和“没有套餐”混为一谈，误拦已有套餐用户。
    // 主页只做导航，按任一 Coding Plan 放行；表单提交仍由 Automations 的 selected support 严格拦截。
    if (codingPlanUnavailable) {
      logger.debug("[off-peak] blocked home template without any Coding Plan", {
        templateId: template.id,
      });
      showCodingPlanRequiredToast();
      return;
    }
    // Bugfix：首页文案走 i18n、草稿却曾写死英文，导致中文系统点击模板后创建页中英混排。
    // 点击时按当前 locale 生成同源标题与指令；Customize 仍保持空白创建。
    const materialized = materializeOffPeakTemplateDraft(template, locale);
    const draft: OffPeakCreateDraft = {
      ...(template.customize ? {} : { title: materialized.title, prompt: materialized.prompt }),
      telemetrySource: {
        eventRegion: "app.session",
        templateId: template.id,
      },
    };
    setPendingCreateDraft(draft);
    onOpenAutomations?.();
  };

  return (
    // 5488-3978：入口常驻草稿页底部，pb-[38px] 给出与窗口底部的固定间距；
    // 宽度不依赖 @container/conversation 断点外扩（该容器只声明在 timeline 内部）。
    <div
      data-off-peak-new-task-entry="true"
      className="flex w-full shrink-0 flex-col items-center gap-3 px-4 pb-[38px]"
    >
      {/* 引导横幅：32px 图标位 + 4px 间距 + 主文案/说明 Tooltip，整体水平居中；
          关闭钮本轮设计隐藏（见下方注释） */}
      <div
        data-off-peak-new-task-banner="true"
        className="flex w-full max-w-[580px] items-center justify-center"
      >
        <div className="flex min-w-0 items-center gap-1 text-foreground-subtle opacity-80">
          <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            <Megaphone className="size-4" strokeWidth={2} />
          </span>
          {/* Bug 原因：资格说明与主文案拼成单行后触发省略号，用户既看不全主文案，
              也无法单独查看括号内限制。主文案完整换行，并由整个文案区域承接说明 Tooltip；
              普通文本提示不使用 cursor-help，避免额外出现带问号的光标。 */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* 修复原因：caption 字号随 UI 设置缩放，使用相对行高避免大字号时文字被固定 18px 行盒裁切。 */}
                <span
                  tabIndex={0}
                  className="min-w-0 cursor-default rounded-sm text-ui-caption font-normal leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-hover"
                >
                  {intl.formatMessage({ id: "offPeak.newTask.bannerText" })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="max-w-none whitespace-nowrap">
                <span>
                  {intl.formatMessage({
                    id: "offPeak.newTask.bannerTipText",
                  })}
                </span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {/* 5488-3978 暂不提供关闭入口：按产品要求只隐藏、不删除实现，
            dismissNewTaskBanner 与 offPeak.newTask 关闭语义保持可用；
            重新放开时把 hidden 换回 flex 即可（两者同属 display 组，不能并存）。 */}
        <button
          type="button"
          data-off-peak-new-task-dismiss="true"
          onClick={dismiss}
          aria-label={intl.formatMessage({ id: "common.close" })}
          className="ml-auto hidden size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtle opacity-80 hover:bg-hover hover:opacity-100"
        >
          <X className="size-4" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* 远程模板按钮使用等宽栅格；桌面横排，窄屏单列，
          描述不锁固定高度，由同一行最高内容拉伸卡片。 */}
      <div
        data-off-peak-template-grid="true"
        className="grid w-full max-w-[780px] grid-cols-1 gap-4 sm:grid-cols-3"
      >
        {offPeakTemplates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => handleCardClick(template)}
            className="flex h-full w-full flex-col gap-2 rounded-2xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center gap-1.5 text-foreground">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <ClientSceneLucideIcon
                  name={template.iconName}
                  aria-hidden="true"
                  className="size-4"
                  size={16}
                  strokeWidth={2}
                  fallback={
                    <Moon
                      aria-hidden="true"
                      className="size-4"
                      data-off-peak-homepage-template-icon="moon"
                      size={16}
                      strokeWidth={2}
                    />
                  }
                />
              </span>
              <span className="truncate text-ui-base leading-5 text-foreground">
                {resolveOffPeakTemplateText(template, "title", locale, intl.formatMessage)}
              </span>
            </div>
            <p className="text-wrap-phrase line-clamp-2 text-ui-caption font-normal leading-snug text-foreground-subtle">
              {resolveOffPeakTemplateText(
                template,
                "homepageDescription",
                locale,
                intl.formatMessage,
              )}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
