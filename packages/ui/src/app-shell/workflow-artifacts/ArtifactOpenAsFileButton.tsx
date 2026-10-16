import { useCallback, useRef, useState } from "react";
import type { EditorInfo, IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

/**
 * 产物 tab 头部的「作为文件打开」分段按钮（docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是引擎的 `RunSettlement.artifact`。
 *
 * 文件是宿主按 tab **已经读到的那一版字节**写出的本机副本（`materializeWorkflowArtifactFile`），
 * 不是 CLI artifact store 里的文件——理由见 desktop 的 `workflowArtifactFile.ts`。主按钮用系统
 * 默认 App 打开；chevron 列出已装 App（与其它「打开方式」同一份列表与偏好，文件管理器在前），
 * 其后是位置类动作：「在工作区显示」（产物有本机可达的工作区出处时）与「复制绝对路径」。
 * 「在工作区显示」收进这里，是为了头部只留一个文件控件；宿主不能落副本（手机远控、普通 Web）
 * 时整个按钮缺席，调用方据 {@link useCanOpenArtifactAsFile} 把「在工作区显示」放回头部。
 */
interface ArtifactOpenAsFileButtonProps {
  runId: string;
  artifactId: string;
  version: number;
  /** 副本的文件名（含扩展名，扩展名决定系统用哪个 App 打开）。 */
  fileName: string;
  /** **这一版**的字节；还没读到（或读到的属于别的版本）时传 null，按钮禁用。 */
  bytes: Uint8Array | null;
  /** 「在工作区显示」：已绑定好路径的文件树 reveal；缺席即菜单里没有这一项。 */
  onReveal?: () => void;
}

type MaterializeCapablePlatform = IPlatformService &
  Required<Pick<IPlatformService, "materializeWorkflowArtifactFile" | "openExternalFile">>;

function canOpenAsFile(platform: IPlatformService | null): platform is MaterializeCapablePlatform {
  return (
    platform !== null &&
    platform.materializeWorkflowArtifactFile !== undefined &&
    platform.openExternalFile !== undefined
  );
}

/** 当前宿主能不能「作为文件打开」——头部据此决定「在工作区显示」进菜单还是独立成按钮。 */
export function useCanOpenArtifactAsFile(): boolean {
  return canOpenAsFile(useOptionalPlatform());
}

export function ArtifactOpenAsFileButton(props: ArtifactOpenAsFileButtonProps) {
  const platform = useOptionalPlatform();
  if (!canOpenAsFile(platform)) return null;
  return <OpenAsFileSplitButton {...props} platform={platform} />;
}

function OpenAsFileSplitButton({
  runId,
  artifactId,
  version,
  fileName,
  bytes,
  onReveal,
  platform,
}: ArtifactOpenAsFileButtonProps & { platform: MaterializeCapablePlatform }) {
  const { intl } = useZCodeIntl();
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);

  // 一版一个副本路径：同一版再打开不再把最多 20 MiB 的字节重传一遍 IPC。存的是 promise，
  // 连点两下也只落一次；失败即出缓存，下一次点击重试。
  const pathsRef = useRef(new Map<string, Promise<string>>());
  const ensureLocalPath = useCallback((): Promise<string> => {
    const key = `${runId}\u0000${artifactId}\u0000${version}\u0000${fileName}`;
    const cached = pathsRef.current.get(key);
    if (cached !== undefined) return cached;
    if (bytes === null) return Promise.reject(new Error("artifact bytes are not loaded"));
    const pending = platform
      .materializeWorkflowArtifactFile({ runId, artifactId, version, fileName, bytes })
      .then((result) => result.localPath);
    pathsRef.current.set(key, pending);
    pending.catch(() => pathsRef.current.delete(key));
    return pending;
  }, [artifactId, bytes, fileName, platform, runId, version]);

  const reportFailure = useCallback(
    (action: string, error: unknown) => {
      logger.warn("[workflow-artifacts] 作为文件打开失败", {
        action,
        artifactId,
        error: error instanceof Error ? error.message : String(error),
        runId,
        version,
      });
      toast(intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFileFailed" }));
    },
    [artifactId, intl, runId, version],
  );

  const openWith = useCallback(
    (
      action: string,
      open: (localPath: string) => Promise<{ success: boolean; error?: string }>,
    ) => {
      void ensureLocalPath()
        .then(open)
        .then((result) => {
          if (!result.success) reportFailure(action, result.error ?? "unknown-error");
        })
        .catch((error: unknown) => reportFailure(action, error));
    },
    [ensureLocalPath, reportFailure],
  );

  const handleOpenDefault = () =>
    openWith("default-app", (localPath) => platform.openExternalFile(localPath));

  const handleOpenInEditor = (editor: EditorInfo) => {
    persistLastSelectedEditorId(editor.id);
    // 副本恒在宿主本机上：远程工作区也不带 remoteTarget，否则会被当成远端路径去开。
    openWith(`editor:${editor.id}`, (localPath) =>
      platform.openInEditor(editor.id, localPath, { pathKind: "file" }),
    );
  };

  const handleCopyPath = () => {
    void ensureLocalPath()
      .then((localPath) => navigator.clipboard?.writeText(localPath))
      .catch((error: unknown) => reportFailure("copy-path", error));
  };

  const loadEditors = () => {
    if (editors !== null) return;
    void platform
      .getInstalledEditors()
      .then((installed) => setEditors(sortInstalledEditorsForOpenWith(installed)))
      .catch((error: unknown) => {
        logger.warn("[workflow-artifacts] 获取打开方式失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        setEditors([]);
      });
  };

  const disabled = bytes === null;
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFile" });
  const chooseLabel = intl.formatMessage({ id: "appHeader.selectOpenApp" });

  return (
    <DropdownMenu onOpenChange={(open) => open && loadEditors()}>
      {/* 分段外壳：主动作在左、菜单在右（DESIGN.md「Composite triggers」）。高度对齐头部的 sm 按钮。 */}
      <div className="flex h-6 shrink-0 items-center overflow-hidden rounded-md border border-border bg-input transition-colors hover:border-border-hover">
        <Button
          className="h-6 rounded-none border-0 pr-1.5"
          data-testid="workflow-artifact-open-as-file"
          disabled={disabled}
          onClick={handleOpenDefault}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={chooseLabel}
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            data-testid="workflow-artifact-open-as-file-menu"
            disabled={disabled}
            size="icon-sm"
            title={chooseLabel}
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-48">
        {editors === null || editors.length === 0 ? (
          <DropdownMenuItem disabled>
            {intl.formatMessage({
              id: editors === null ? "common.loading" : "chat.previewCards.noOpenApps",
            })}
          </DropdownMenuItem>
        ) : (
          editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
              <img alt="" className="size-4 shrink-0" src={editor.iconDataUrl} />
              <span className="truncate">{editor.name}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        {onReveal === undefined ? null : (
          // 显示的是工作区里的原件，不落副本（与 tab 头部原来那颗按钮同一条路径）。
          <DropdownMenuItem data-testid="workflow-artifact-open-as-file-reveal" onSelect={onReveal}>
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleCopyPath}>
          <CopyIcon aria-hidden="true" className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
