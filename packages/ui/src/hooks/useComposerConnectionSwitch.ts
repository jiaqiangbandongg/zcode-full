import { completeNewModelSelection } from "@zcode/provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistProviderFamilyConnection } from "@/lib/providerFamilyConnectionTransition.js";
import { chooseConnectionModel, type ComposerConnection } from "@/lib/composerPlanGroups.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { logger } from "@/logger.js";
import { resolveModelProviderFamilySpecByProviderId, type ZCodeProvider } from "@zcode/shared";

export function useComposerConnectionSwitch({
  workspacePath,
  workspaceIdentity,
  agentProvider,
  normalizedValue,
  onSelectModel,
  waitForPresentation = false,
  presentationStatus = "ready",
  presentationRevision,
  presentationErrorRevision,
  refreshPresentation,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  agentProvider: ZCodeProvider;
  normalizedValue: string;
  onSelectModel: (value: string, reasoningLevel?: string) => void;
  waitForPresentation?: boolean;
  presentationStatus?: "ready" | "loading" | "error" | "unavailable";
  presentationRevision?: number;
  presentationErrorRevision?: number;
  refreshPresentation?: () => Promise<unknown>;
}) {
  const base = useBaseWorkspaceServices();
  const { services: target, rpcReady } = useWorkspaceServicesResolution(
    workspacePath,
    undefined,
    workspaceIdentity,
  );
  const { update } = useSettings({ services: base });
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const token = useMemo(() => ({}), [target, base, workspaceKey]);
  const owner = useRef({ token, mounted: true });
  owner.current = { token, mounted: true };
  const inFlight = useRef(false);
  const [state, setState] = useState<{
    pending: boolean;
    error: string | null;
    previousKey?: string;
    expectedValue?: string;
    expectedRevision?: number;
  }>({
    pending: false,
    error: null,
  });
  useEffect(() => {
    setState({ pending: false, error: null });
    inFlight.current = false;
    return () => {
      owner.current.mounted = false;
    };
  }, [target, base, workspaceKey]);
  useEffect(() => {
    if (!state.expectedValue) return;
    if (
      presentationStatus === "error" ||
      presentationStatus === "unavailable" ||
      // 原因：旧 ready 可保留目录，但目标刷新失败必须是本次切换的终态。
      (presentationErrorRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationErrorRevision >= state.expectedRevision)
    ) {
      inFlight.current = false;
      setState({
        pending: false,
        error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    } else if (presentationStatus === "ready") {
      // 原因：选择 owner 在重读时保留旧 ready；只有目标目录版本到达才是本次展示回执。
      if (
        presentationRevision !== undefined &&
        state.expectedRevision !== undefined &&
        presentationRevision < state.expectedRevision
      )
        return;
      // 原因：RPC 完成早于 Renderer 的选择重解析；提前结束 loading 会暴露新旧目录混合帧。
      inFlight.current = false;
      // 原因：有效选择可能被过滤或被另一草稿改写；ready 不匹配也必须结束等待，不能永久锁住工具条。
      const matched = normalizedValue === state.expectedValue;
      if (!matched)
        logger.lifecycle.warn("[composer-connection] 展示选择与目标不匹配", {
          expectedValue: state.expectedValue,
          normalizedValue,
        });
      setState({
        pending: false,
        error: matched ? null : intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
      });
    }
  }, [
    state.expectedValue,
    state.expectedRevision,
    presentationStatus,
    presentationRevision,
    presentationErrorRevision,
    normalizedValue,
    intl,
  ]);
  const select = useCallback(
    async (connection: ComposerConnection, previousKey?: string) => {
      if (inFlight.current || !rpcReady || connection.disabled) return;
      const currentOwner = owner.current;
      const stillCurrent = () =>
        owner.current.mounted && owner.current.token === currentOwner.token;
      inFlight.current = true;
      setState({ pending: true, error: null, previousKey });
      let awaitingPresentation = false;
      try {
        const readModels = async (restoring = false) => {
          if (!restoring && !stillCurrent()) throw new Error("Composer connection owner changed");
          // 配置写入由根 Host 管理；执行候选始终从目标 Host 读取，不向远端伪造本地目录。
          const baseView = await base.providerSettingsService.refresh("composer-connection");
          if (target !== base && stillCurrent()) {
            const targetView = await target.providerSettingsService.refresh("composer-connection");
            // 远端配置交付由既有 provisioning owner 管理；旧团队也可能有同名模型，
            // 必须核对账号连接身份，不能把目录非空误判成新团队已同步。
            const expected = baseView.providers.find((p) => p.providerId === connection.providerId)
              ?.accountState?.connectionKey;
            const actual = targetView.providers.find((p) => p.providerId === connection.providerId)
              ?.accountState?.connectionKey;
            if (!restoring && (!expected || actual !== expected))
              throw new Error("Target connection has not synchronized");
          }
          const view = await (stillCurrent() ? target : base).modelSelectionService.getView();
          const candidate = buildRegistryModelSelectGroups(agentProvider, view).find(
            (g) => g.key === `registry-provider:${connection.providerId}`,
          );
          if (!restoring && !candidate?.items.length)
            throw new Error("Selected connection has no available models");
          return view;
        };
        const view = connection.selection
          ? await persistProviderFamilyConnection({
              family: connection.family,
              selection: connection.selection,
              read: () => base.settingService.get(),
              update,
              synchronize: readModels,
            })
          : await target.modelSelectionService.getView();
        if (!stillCurrent()) return;
        const group = buildRegistryModelSelectGroups(agentProvider, view).find(
          (g) => g.key === `registry-provider:${connection.providerId}`,
        );
        const model = chooseConnectionModel(
          group?.items ?? [],
          decodeCustomModelValue(normalizedValue)?.modelName,
        );
        if (!model) throw new Error("Selected connection has no available models");
        logger.debug("[composer-connection] 连接同步完成", {
          providerId: connection.providerId,
          connectionKey: connection.key,
          workspaceKey,
        });
        const source = decodeCustomModelValue(normalizedValue);
        const family = resolveModelProviderFamilySpecByProviderId(source?.providerId ?? "");
        // 原因：个人/团队的同名模型已经由账号 Selection resolver 自动映射并校验 options。
        // 再走普通选模会重建无 reasoning 的意图，同时触发第二轮目录重读和菜单闪烁。
        const sameAccountModel =
          connection.selection &&
          family?.id === connection.family &&
          (source?.providerId === family.individualCodingPlanProviderId ||
            source?.providerId === family.teamCodingPlanProviderId) &&
          source?.modelName === model.name;
        if (!sameAccountModel) {
          // 原因：API → 团队时 Renderer 仍持有切换前目录，不能让旧闭包补齐目标档位。
          // 直接使用同步完成的目标 Host 目录，将模型与档位一次交给草稿 owner。
          const selection = completeNewModelSelection(view, {
            providerId: connection.providerId,
            modelId: model.name,
          });
          const reasoningLevel = selection?.options?.reasoningLevel;
          if (reasoningLevel) onSelectModel(model.value, reasoningLevel);
          else onSelectModel(model.value);
        }
        if (waitForPresentation) {
          // 原因：重选同连接可能没有目录事件；每次显式读取当前展示 owner，不消费旧失败回执。
          await refreshPresentation?.();
          if (!stillCurrent()) return;
          awaitingPresentation = true;
          setState({
            pending: true,
            error: null,
            previousKey,
            expectedValue: model.value,
            expectedRevision: view.revision,
          });
        }
      } catch (error) {
        // 连接切换失败属于低频生命周期诊断，生产回放也需要保留明确失败原因。
        logger.lifecycle.warn("[composer-connection] 切换连接失败", {
          providerId: connection.providerId,
          workspaceKey,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          causes:
            error instanceof AggregateError
              ? error.errors.map((cause) => String(cause))
              : undefined,
        });
        if (stillCurrent())
          setState({
            pending: false,
            error: intl.formatMessage({ id: "chat.toolbar.connection.switchFailed" }),
          });
      } finally {
        if (stillCurrent() && !awaitingPresentation) {
          inFlight.current = false;
          setState((previous) => ({ ...previous, pending: false }));
        }
      }
    },
    [
      agentProvider,
      base,
      intl,
      normalizedValue,
      onSelectModel,
      rpcReady,
      target,
      update,
      workspaceKey,
      waitForPresentation,
      refreshPresentation,
    ],
  );
  return { ...state, select };
}
