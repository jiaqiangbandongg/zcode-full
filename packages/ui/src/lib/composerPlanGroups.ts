import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import {
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyDomain,
  type ProviderFamilyConnectionSelection,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import {
  buildRegistryModelSelectGroups,
  type ModelProviderGroupLabelOptions,
} from "@/lib/modelSelectionGroups.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";
export interface ComposerConnection {
  key: string;
  label: string;
  providerId: string;
  family: ProviderFamilyDomain;
  selection?: ProviderFamilyConnectionSelection;
  items: ModelSelectGroupItem[];
  disabled?: boolean;
}
export interface ComposerPlanGroup extends ModelSelectGroup {
  connection?: ComposerConnection;
}
interface TeamProduct {
  family?: ProviderFamilyDomain;
  productId: string;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  apiKeyStatus?: string | null;
  teamProjects?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projectId?: string | null;
    apiKeyStatus?: string | null;
  }> | null;
}
export function composerConnectionKey(
  family: ProviderFamilyDomain,
  selection: ProviderFamilyConnectionSelection,
) {
  return JSON.stringify(
    selection.kind === "team-coding-plan"
      ? [family, selection.kind, selection.productId, selection.organizationId, selection.projectId]
      : [family, selection.kind],
  );
}
export function chooseConnectionModel(items: readonly ModelSelectGroupItem[], model?: string) {
  return items.find((item) => item.name === model) ?? items[0];
}
/** 只投影账号套餐行；API、自定义供应商及模型目录仍沿用原始对象。 */
export function buildComposerPlanGroups(
  groups: readonly ModelSelectGroup[],
  products: readonly TeamProduct[],
  settingsView?: ProviderSettingsView | null,
  agentProvider: ZCodeProvider = "glm",
  labels: ModelProviderGroupLabelOptions = {},
  selections?: Partial<Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>>,
): ComposerPlanGroup[] {
  // 原因：团队共用 Provider ID，服务状态只校验当前团队；不能整组隐藏其他团队身份。
  const isAvailable = (providerId: string) =>
    settingsView?.providers.find((provider) => provider.providerId === providerId)?.accountState
      ?.availability !== "unavailable";
  const isTeamProvider = (providerId: string) =>
    providerId === resolveModelProviderFamilySpecByProviderId(providerId)?.teamCodingPlanProviderId;
  const includeProvider = (providerId: string) =>
    isTeamProvider(providerId) || isAvailable(providerId);
  const missing =
    settingsView?.providers
      .filter(
        (p) =>
          !groups.some((g) => g.key === `registry-provider:${p.providerId}`) &&
          p.enabled &&
          includeProvider(p.providerId) &&
          p.effectiveConfig.access?.type === "zhipu-account" &&
          (p.effectiveConfig.access.mode === "team-coding-plan" ||
            (p.effectiveConfig.access.mode === "individual-coding-plan" &&
              p.accountState?.availability === "available" &&
              p.accountState.entitled)),
      )
      .map((p) => ({ providerId: p.providerId, config: p.effectiveConfig, models: [] })) ?? [];
  const candidates = [
    ...groups.filter((group) => includeProvider(group.key.replace(/^registry-provider:/, ""))),
    // 原因：未激活个人套餐由此补充；漏传当前语言会回退成英文 Individual。
    ...buildRegistryModelSelectGroups(
      agentProvider,
      {
        revision: 0,
        providers: missing,
      } as ModelSelectionView,
      labels,
    ),
  ];
  const plans: ComposerPlanGroup[] = [];
  const others: ComposerPlanGroup[] = [];
  for (const group of candidates) {
    const providerId = group.key.replace(/^registry-provider:/, "");
    const spec = resolveModelProviderFamilySpecByProviderId(providerId);
    if (!spec || providerId === spec.startPlanProviderId) {
      others.push(group);
      continue;
    }
    if (providerId === spec.individualCodingPlanProviderId) {
      const selection = { kind: "individual-coding-plan" as const };
      plans.push({
        ...group,
        connection: {
          key: group.key,
          label: group.labelBadge ?? "",
          providerId,
          family: spec.id,
          selection,
          items: group.items,
        },
      });
      continue;
    }
    if (providerId !== spec.teamCodingPlanProviderId) {
      others.push(group);
      continue;
    }
    const seen = new Set<string>();
    for (const product of products) {
      if (
        (product.family ?? "bigmodel") !== spec.id ||
        product.subscribed !== true ||
        !product.productId.trim()
      )
        continue;
      for (const project of product.teamProjects?.length ? product.teamProjects : [product]) {
        const organizationId = project.organizationId?.trim();
        const projectId = project.projectId?.trim();
        const label = formatTeamPlanDisplayName({
          organizationName: project.organizationName ?? product.organizationName,
        });
        // 不可用是明确的凭据事实；unknown 仅表示尚未确认，不能误当不可用隐藏。
        if (
          !organizationId ||
          !projectId ||
          !label ||
          (project.apiKeyStatus ?? product.apiKeyStatus) === "unavailable"
        )
          continue;
        const selection = {
          kind: "team-coding-plan" as const,
          productId: product.productId,
          organizationId,
          projectId,
        };
        const key = composerConnectionKey(spec.id, selection);
        const selected = selections?.[spec.id];
        // 当前团队过期不能补回；其他团队的状态未知时仍允许用户切换。
        if (
          !isAvailable(providerId) &&
          selected?.kind === "team-coding-plan" &&
          key === composerConnectionKey(spec.id, selected)
        )
          continue;
        if (seen.has(key)) continue;
        seen.add(key);
        plans.push({
          ...group,
          key,
          labelBadge: label,
          connection: {
            key,
            label,
            providerId,
            family: spec.id,
            selection,
            items: group.items,
          },
        });
      }
    }
    // 目录晚到时保留当前 Provider 身份，不能把团队同名模型错勾到个人行。
    if (
      !seen.size &&
      isAvailable(providerId) &&
      group.items.length &&
      !products.some((product) => (product.family ?? "bigmodel") === spec.id)
    )
      plans.push(group);
  }
  // 同品牌个人排在团队之前；API 与 Start Plan 内部顺序不变。
  return [
    ...plans.sort(
      (a, b) =>
        a.label.localeCompare(b.label) ||
        Number(a.connection?.selection?.kind === "team-coding-plan") -
          Number(b.connection?.selection?.kind === "team-coding-plan"),
    ),
    ...others,
  ];
}
