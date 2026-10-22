import type { ReactNode, RefObject } from "react";
import type { DocKind, DocumentInfo } from "#office/contract.ts";
import type { Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { baseName } from "#ui/rpc.ts";
import { ErrorState, Skeleton } from "#ui/shell/panes.tsx";
import type { Failure } from "#ui/shell/state.ts";

/**
 * 内联（对话内嵌）模式的面板：只读预览，点击任意处切到侧栏全屏。
 * 从 main.tsx 的 Shell 拆出以控制单文件规模；查看器元素与各 ref 仍由 Shell 持有并传入。
 */
export function InlineShell({
  appRef,
  canvasRef,
  t,
  path,
  info,
  kind,
  showSkeleton,
  failure,
  nothing,
  onExpand,
  children,
}: {
  appRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  t: Strings;
  path: string | null;
  info: DocumentInfo | undefined;
  kind: DocKind | null;
  showSkeleton: boolean;
  failure: Failure | null;
  nothing: boolean;
  onExpand(): void;
  children: ReactNode;
}) {
  return (
    <div ref={appRef} className="app inline">
      <header className="docbar">
        <div className="doctitle static" title={path ?? undefined}>
          <span className="name">{path ? baseName(path) : t.title}</span>
          {info && t.meta[info.kind](info.units) ? (
            <span className="meta">{t.meta[info.kind](info.units)}</span>
          ) : null}
        </div>
        <span className="spacer" />
        <button type="button" className="btn sm" title={t.sidePanel} onClick={onExpand}>
          <Icon name="maximize-2" size={12} />
          {t.sidePanel}
        </button>
      </header>
      <div className="stage">
        <div ref={canvasRef} className="canvas">
          {children}
          {showSkeleton ? <Skeleton kind={kind} /> : null}
          {failure ? (
            <ErrorState
              t={t}
              title={failure.title}
              detail={failure.detail}
              onOpenAnother={onExpand}
            />
          ) : null}
          {nothing ? <div className="failed muted">{t.openTitle}</div> : null}
          <button
            type="button"
            className="glance-cover"
            aria-label={t.sidePanel}
            onClick={onExpand}
          />
        </div>
      </div>
    </div>
  );
}
