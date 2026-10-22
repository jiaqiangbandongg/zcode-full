import { importSelectedFile } from "#ui/rpc.ts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { DOC_KINDS, MAX_FILE_BYTES, type DocKind, type DocumentInfo } from "#office/contract.ts";
import { type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import type { PageState, ViewerHandle } from "#ui/viewers/types.ts";

// 面板的文档导航与状态界面（抽屉、文件选择、空态、骨架、错误、文件变更提示），从 parts.tsx 拆出以控制单文件规模。

/* ---------------------------------------------------------------- Drawer */

export type DrawerTab = "pages" | "outline";

function Thumbnail({
  handle,
  page,
  width,
  ratio,
  current,
  onPick,
  root,
}: {
  handle: ViewerHandle;
  page: number;
  width: number;
  ratio: number;
  current: boolean;
  onPick(page: number): void;
  root: RefObject<HTMLElement | null>;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slot.current;
    if (!element || !handle.thumbnail) return;
    let done = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) return;
        done = true;
        observer.disconnect();
        void handle.thumbnail!(page, width).then(
          (thumb) => {
            element.replaceChildren(thumb);
            element.style.height = "";
          },
          () => undefined,
        );
      },
      { root: root.current, rootMargin: "300px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [handle, page, width, root]);
  return (
    <button
      type="button"
      className={`thumb${current ? " on" : ""}`}
      aria-current={current ? "page" : undefined}
      onClick={() => onPick(page)}
      data-page={page}
    >
      <div ref={slot} className="mini" style={{ width, height: Math.round(width * ratio) }} />
      <span>{page}</span>
    </button>
  );
}

const outlinePage = (at: string) => /^(?:page|slide):(\d+)/.exec(at)?.[1] ?? "";

export function Drawer({
  t,
  info,
  handle,
  page,
  tab,
  docked,
  onTab,
  onPage,
  onOutline,
}: {
  t: Strings;
  info: DocumentInfo;
  handle: ViewerHandle | null;
  page: PageState | null;
  tab: DrawerTab;
  docked: boolean;
  onTab(tab: DrawerTab): void;
  onPage(page: number): void;
  onOutline(at: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const hasPages = Boolean(handle?.thumbnail && page);
  const hasOutline = info.outline.length > 0;
  const shown: DrawerTab = hasPages && (tab === "pages" || !hasOutline) ? "pages" : "outline";
  const ratio = info.kind === "pptx" ? 9 / 16 : 1.294;
  // Bring the current page into the drawer's view when it opens or switches tab.
  useEffect(() => {
    const current = scroller.current?.querySelector<HTMLElement>("[aria-current=page]");
    if (current && scroller.current)
      scroller.current.scrollTop = current.offsetTop - scroller.current.clientHeight / 3;
  }, [shown]);
  const currentOutline = (() => {
    if (!page) return -1;
    let found = -1;
    info.outline.forEach((item, i) => {
      const n = Number(outlinePage(item.at));
      if (n && n <= page.current) found = i;
    });
    return found;
  })();
  return (
    <nav className={`drawer${docked ? " docked" : ""}`} aria-label={t.pagesAndOutline}>
      {hasPages && hasOutline ? (
        <div className="seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={shown === "pages"}
            className={shown === "pages" ? "on" : ""}
            onClick={() => onTab("pages")}
          >
            {info.kind === "pptx" ? t.slides : t.pages}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={shown === "outline"}
            className={shown === "outline" ? "on" : ""}
            onClick={() => onTab("outline")}
          >
            {t.outline}
          </button>
        </div>
      ) : null}
      <div ref={scroller} className={shown === "pages" ? "thumbs" : "outline"}>
        {shown === "pages" && handle && page
          ? Array.from({ length: page.count }, (_, i) => (
              <Thumbnail
                key={i}
                handle={handle}
                page={i + 1}
                width={136}
                ratio={ratio}
                current={page.current === i + 1}
                onPick={onPage}
                root={scroller}
              />
            ))
          : info.outline.map((item, i) => (
              <button
                type="button"
                key={`${item.at}-${i}`}
                className={`oi level-${Math.min(3, Math.max(1, item.level))}${i === currentOutline ? " on" : ""}`}
                aria-current={i === currentOutline ? "page" : undefined}
                title={item.label}
                onClick={() => onOutline(item.at)}
              >
                <span className="label">{item.label}</span>
                <span className="n">{outlinePage(item.at)}</span>
              </button>
            ))}
      </div>
    </nav>
  );
}

/* ---------------------------------------------------------------- Empty, picker, skeleton, error */

export function EmptyState({
  t,
  onBrowse,
  importing,
}: {
  t: Strings;
  onBrowse(): void;
  importing: boolean;
}) {
  return (
    <div className="empty">
      <div className="empty-content">
        <h3>{t.emptyTitle}</h3>
        <p className="empty-description">{t.emptyDescription}</p>
        <button type="button" className="btn empty-open" onClick={onBrowse} disabled={importing}>
          <Icon name="folder-open" size={16} />
          {importing ? t.importing : t.openFile}
        </button>
        <p className="empty-caption">{t.emptyCaption}</p>
      </div>
    </div>
  );
}

const SKELETON_LINES = [
  "title",
  "subtitle",
  "line",
  "line",
  "short",
  "heading",
  "line",
  "line",
  "line",
  "mid",
  "figure",
];

export function Skeleton({ kind }: { kind: DocKind | null }) {
  if (kind === "xlsx")
    return (
      <div className="skeleton sheet" aria-busy="true">
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="skel-row" />
        ))}
      </div>
    );
  const slide = kind === "pptx";
  return (
    <div className="skeleton" aria-busy="true">
      {[0, 1].map((n) => (
        <div key={n} className={`skelpage${slide ? " slide" : ""}`}>
          {n === 0 && !slide
            ? SKELETON_LINES.map((line, i) => <div key={i} className={`skel ${line}`} />)
            : null}
          {n === 0 && slide ? (
            <>
              <div className="skel title left" />
              <div className="skel line" />
              <div className="skel mid" />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  t,
  title,
  detail,
  onOpenAnother,
}: {
  t: Strings;
  title: string;
  detail: string;
  onOpenAnother(): void;
}) {
  return (
    <div className="failed" role="alert">
      <Icon name="file-text" size={28} className="subtlest" />
      <div>
        <h3>{title}</h3>
        {detail ? <p>{detail}</p> : null}
      </div>
      <button type="button" className="btn secondary" onClick={onOpenAnother}>
        {t.openAnother}
      </button>
    </div>
  );
}

export function ChangedBanner({
  t,
  onReload,
  onDismiss,
}: {
  t: Strings;
  onReload(): void;
  onDismiss(): void;
}) {
  return (
    <div className="banner" role="status">
      <span>{t.changed}</span>
      <button type="button" className="btn sm primary" onClick={onReload}>
        {t.reloadShort}
      </button>
      <button
        type="button"
        className="btn icon sm dim"
        title={t.dismiss}
        aria-label={t.dismiss}
        onClick={onDismiss}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

// 使用系统文件选择器，取消时不改变当前文档；选中的内容通过受限导入接口进入工作区。
export function NativeFileInput({
  inputRef,
  t,
  importing,
  onImporting,
  onOpen,
  onError,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  t: Strings;
  importing: boolean;
  onImporting(value: boolean): void;
  onOpen(path: string): void;
  onError(error: unknown, name: string): void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      hidden
      accept={DOC_KINDS.map((kind) => `.${kind}`).join(",")}
      disabled={importing}
      onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        onImporting(true);
        try {
          if (file.size > MAX_FILE_BYTES) throw new Error(t.importTooLarge);
          onOpen(await importSelectedFile(file));
        } catch (error) {
          onError(error, file.name);
        } finally {
          onImporting(false);
        }
      }}
    />
  );
}

export function useNativeFileInput(
  t: Strings,
  onOpen: (path: string) => void,
  onError: (error: unknown, name: string) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, onImporting] = useState(false);
  return {
    importing,
    browse: () => inputRef.current?.click(),
    input: <NativeFileInput {...{ inputRef, t, importing, onImporting, onOpen, onError }} />,
  };
}
