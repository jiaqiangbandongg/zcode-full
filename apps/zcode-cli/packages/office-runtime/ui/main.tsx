import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import {
  kindOf,
  type DocKind,
  type DocumentInfo,
  type DocxBlockKey,
  type FileHandle,
  type Selection,
  type ShowTarget,
  type ViewerSnapshot,
} from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import { readFileBytes } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";
import {
  clip,
  describeFailure,
  readRecent,
  useHostContext,
  writeRecent,
  type AgentPointer,
  type Failure,
  type LoadedDoc,
  type Picked,
  type Reference,
} from "#ui/shell/state.ts";
import { describeAt, strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { baseName, call } from "#ui/rpc.ts";
import { InlineShell } from "#ui/shell/inline.tsx";
import { MoreMenu, SwitchMenu } from "#ui/shell/menus.tsx";
import {
  ChangedBanner,
  Drawer,
  EmptyState,
  useNativeFileInput,
  ErrorState,
  Skeleton,
  type DrawerTab,
} from "#ui/shell/panes.tsx";
import {
  AgentCallout,
  FindBar,
  OffscreenChip,
  PagePill,
  SelectionBar,
  offscreenText,
  type BarMode,
} from "#ui/shell/parts.tsx";
import { CLOSED_FIND, useFind } from "#ui/shell/useFind.ts";
import { useCaptureView } from "#ui/shell/useCaptureView.ts";
import { useOffscreenTargets } from "#ui/shell/useOffscreenTargets.ts";
import { useShellKeys } from "#ui/shell/useShellKeys.ts";
import { VIEWERS } from "#ui/viewers/registry.ts";
import type {
  PageState,
  RevealedTarget,
  SelectionDetail,
  ViewerHandle,
  ZoomState,
} from "#ui/viewers/types.ts";

const host = getHost();

const PAGED: DocKind[] = ["pdf", "docx", "pptx"];
/** Viewers with fit modes and zoom in the page control. */
const ZOOMABLE: DocKind[] = ["pdf", "docx"];
/** Below this panel width the drawer floats over the pages; at or above it, it docks. */
const DOCK_WIDTH = 720;
const INLINE_HEIGHT = 380;
function Shell() {
  const context = useHostContext();
  const t = strings(context?.locale ?? navigator.language);
  const dark = context?.theme === "dark";
  const inline = context?.displayMode === "inline";

  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [menu, setMenu] = useState<"switch" | "more" | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({
    open: false,
    tab: "pages",
  });
  const [location, setLocation] = useState<string | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [barMode, setBarMode] = useState<BarMode>("bar");
  const [copied, setCopied] = useState(false);
  const [agent, setAgent] = useState<AgentPointer | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [wide, setWide] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useOffscreenTargets(canvasRef, agent);
  const viewer = useRef<ViewerHandle | null>(null);
  const viewerReady = useRef(false);
  const pendingReveal = useRef<{ targets: ShowTarget[]; note: string | null } | null>(null);
  const lastRevealSeq = useRef(0);
  const docRef = useRef<LoadedDoc | null>(null);
  docRef.current = doc;
  const loadSeq = useRef(0);
  /** Path being loaded; a second load of it without a reveal must not drop the pending one. */
  const loadingPath = useRef<string | null>(null);
  const loadKey = useRef(0);
  const references = useRef<Reference[]>([]);
  const dismissedRevision = useRef<string | null>(null);
  const onOpenFind = useCallback(() => {
    viewer.current?.clearReveal();
    viewer.current?.clearSelection();
    setPicked(null);
    setAgent(null);
    setMenu(null);
  }, []);
  const { find, setFind, openFind, closeFind, queryFind, stepFind } = useFind({
    viewer,
    docRef,
    ready,
    onOpen: onOpenFind,
  });
  /**
   * The agent's current target stays in view until the user scrolls, clicks or types in the
   * document: ZCode animates the pane open, and each resize re-lays the pages out under it.
   */
  const pinned = useRef(false);

  const kind = doc?.info.kind ?? (pending ? kindOf(pending) : null);
  const path = pending ?? failure?.path ?? doc?.info.path ?? null;

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const variables = context?.styles?.variables;
    if (variables) applyHostStyleVariables(variables);
  }, [dark, context?.styles?.variables]);

  useEffect(() => {
    // An inline card is a fixed-height glance; the side panel fills the pane.
    if (inline) void host.app.sendSizeChanged({ height: INLINE_HEIGHT }).catch(() => undefined);
  }, [inline]);

  useEffect(() => {
    const app = appRef.current!;
    const resize = new ResizeObserver(() => setWide(app.clientWidth >= DOCK_WIDTH));
    resize.observe(app);
    return () => resize.disconnect();
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 2500);
  }, []);

  const resetDocumentState = useCallback(() => {
    viewerReady.current = false;
    setReady(false);
    setPicked(null);
    setBarMode("bar");
    setAgent(null);
    setOffscreen(null);
    setLocation(null);
    setPage(null);
    setZoom(null);
    setChanged(null);
    setFind(CLOSED_FIND);
  }, []);

  const load = useCallback(
    async (target: string, reveal?: { targets: ShowTarget[]; note: string | null } | null) => {
      const mine = ++loadSeq.current;
      if (reveal) pendingReveal.current = reveal;
      else if (loadingPath.current !== target) pendingReveal.current = null;
      loadingPath.current = target;
      setPending(target);
      setFailure(null);
      try {
        const loaded = await call<{
          info: DocumentInfo;
          file: FileHandle;
          blocks?: DocxBlockKey[];
        }>("load_document", { path: target });
        const [bytes] = await Promise.all([
          readFileBytes(loaded.file),
          VIEWERS[loaded.info.kind]?.prepare?.(),
        ]);
        if (mine !== loadSeq.current) return;
        resetDocumentState();
        dismissedRevision.current = null;
        setDoc({ info: loaded.info, bytes, blocks: loaded.blocks, key: ++loadKey.current });
        host.saveDocument(loaded.info.path);
        setRecent((items) => {
          const next = [
            { path: loaded.info.path, kind: loaded.info.kind },
            ...items.filter((item) => item.path !== loaded.info.path),
          ].slice(0, 5);
          writeRecent(next);
          return next;
        });
      } catch (error) {
        if (mine !== loadSeq.current) return;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      } finally {
        if (mine === loadSeq.current) {
          setPending(null);
          loadingPath.current = null;
        }
      }
    },
    [resetDocumentState, t],
  );

  const runReveal = useCallback(async (targets: ShowTarget[], note: string | null) => {
    const handle = viewer.current;
    if (!handle) return;
    // The agent's marks and find highlights are never shown together.
    handle.clearFind();
    setFind(CLOSED_FIND);
    const results = await handle.reveal(targets).catch(() => [] as RevealedTarget[]);
    pinned.current = results.length > 0;
    setAgent(
      results.length
        ? { note, targets: results, index: 0, visible: Boolean(note) || results.length > 1 }
        : null,
    );
  }, []);

  const applyReveal = useCallback(
    (targets: ShowTarget[], note: string | null) => {
      if (viewer.current && viewerReady.current) void runReveal(targets, note);
      else pendingReveal.current = { targets, note };
    },
    [runReveal],
  );

  /** Bring the viewer in line with a snapshot from the server (tool result or get_viewer). */
  const applySnapshot = useCallback(
    (snapshot: ViewerSnapshot | undefined) => {
      if (!snapshot?.document) return;
      const reveal =
        snapshot.reveal && snapshot.reveal.seq > lastRevealSeq.current ? snapshot.reveal : null;
      if (reveal) lastRevealSeq.current = reveal.seq;
      const current = docRef.current?.info;
      const pointer = reveal ? { targets: reveal.targets, note: reveal.note ?? null } : null;
      if (
        !current ||
        current.path !== snapshot.document.path ||
        current.revision !== snapshot.document.revision
      ) {
        void load(snapshot.document.path, pointer);
      } else if (pointer) applyReveal(pointer.targets, pointer.note);
    },
    [load, applyReveal],
  );

  // Tool results routed to this panel (open_document, show_in_viewer).
  useEffect(() => {
    const drain = () => {
      for (const result of host.takeResults()) {
        if (result.isError) continue;
        const truncated = (result._meta as Record<string, unknown> | undefined)?.[
          "zcode/truncated"
        ];
        if (truncated) void call<ViewerSnapshot>("get_viewer").then(applySnapshot, () => undefined);
        else applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
      }
    };
    window.addEventListener("office:toolresult", drain);
    void host.ready().then(async () => {
      setRecent(readRecent());
      const buffered = host.takeResults();
      const path = host.readDocument();
      // 恢复本窗口的手动选择优先于历史工具结果；新窗口没有记录，保持空状态。
      if (path) void load(path);
      else for (const result of buffered)
        if (!result.isError) applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
    });
    return () => window.removeEventListener("office:toolresult", drain);
  }, [applySnapshot, load]);

  // Tell the server where the user is (debounced) so get_view answers "what am I looking at".
  const selection = picked?.selection ?? null;
  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(() => {
      void call("report_view", { viewId: host.viewId, path: doc.info.path, at: location, selection }).catch(
        () => undefined,
      );
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, location, selection]);

  // Notice when the file changes on disk under the panel.
  useEffect(() => {
    if (!doc || inline) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void call<{ revision: string }>("check_document", { path: doc.info.path }).then(
        ({ revision }) => {
          if (docRef.current !== doc) return;
          if (revision !== doc.info.revision && revision !== dismissedRevision.current)
            setChanged(revision);
        },
        () => undefined,
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [doc, inline]);

  useCaptureView(docRef, viewer);

  const onReady = useCallback(() => {
    viewerReady.current = true;
    setReady(true);
    const reveal = pendingReveal.current;
    pendingReveal.current = null;
    if (reveal?.targets.length) setTimeout(() => void runReveal(reveal.targets, reveal.note), 50);
  }, [runReveal]);

  const onSelect = useCallback((next: Selection | null, detail?: SelectionDetail) => {
    setBarMode("bar");
    setCopied(false);
    setPicked(next && detail ? { selection: next, detail } : null);
    // Acting on the page dismisses the agent's note (its marks stay).
    if (next && detail?.user) setAgent((current) => current && { ...current, visible: false });
  }, []);

  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timer = 0;
    const resize = new ResizeObserver(() => {
      if (!pinned.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = agentRef.current;
        if (pinned.current && current) current.targets[current.index]?.scrollTo();
      }, 200);
    });
    resize.observe(canvas);
    const unpin = () => {
      pinned.current = false;
    };
    canvas.addEventListener("wheel", unpin, { passive: true });
    canvas.addEventListener("pointerdown", unpin, true);
    canvas.addEventListener("keydown", unpin, true);
    return () => {
      clearTimeout(timer);
      resize.disconnect();
      canvas.removeEventListener("wheel", unpin);
      canvas.removeEventListener("pointerdown", unpin, true);
      canvas.removeEventListener("keydown", unpin, true);
    };
  }, [doc]);
  // Clicking one of the agent's marks brings its note back, when there is one to show.
  const onRevealHit = useCallback((index: number) => {
    const current = agentRef.current;
    if (!current?.targets[index] || !(current.note || current.targets.length > 1)) return false;
    setAgent({ ...current, index, visible: true });
    return true;
  }, []);

  const clearSelection = useCallback(() => {
    viewer.current?.clearSelection();
    setPicked(null);
    setBarMode("bar");
  }, []);

  const addReference = useCallback(async () => {
    const current = docRef.current;
    if (!current || !picked) return;
    const anchor = formatAnchor(current.info.path, picked.selection.at);
    const text = picked.selection.text;
    const next = [
      ...references.current.filter((item) => item.anchor !== anchor || item.text !== text),
      { anchor, text },
    ].slice(-10);
    const lines = next.map(
      (item) => `- ${item.anchor}${item.text ? `: "${clip(item.text, 600)}"` : ""}`,
    );
    try {
      await host.ready();
      await host.app.updateModelContext({
        content: [
          {
            type: "text",
            text: wellFormed(
              `The user referenced these locations in the ${PROFILE.title.en} viewer (use read_document / show_in_viewer with the anchors):\n${lines.join("\n")}`,
            ),
          },
        ],
        structuredContent: wellFormedDeep({ references: next }),
      });
      references.current = next;
      setBarMode("added");
      const added = picked;
      setTimeout(() => {
        if (pickedRef.current === added) clearSelection();
      }, 1500);
    } catch {
      showNotice(t.contextFailed);
    }
  }, [picked, clearSelection, showNotice, t]);

  const ask = useCallback(
    async (question: string) => {
      const current = docRef.current;
      if (!current || !picked) return false;
      const anchor = formatAnchor(current.info.path, picked.selection.at);
      const text = picked.selection.text;
      const quote = text ? `\n> ${clip(text, 800).replace(/\n/g, "\n> ")}` : "";
      try {
        const result = await host.app.sendMessage({
          role: "user",
          content: [
            {
              type: "text",
              text: wellFormed(
                `${question}\n\n(About ${anchor} in the ${PROFILE.title.en} viewer${quote ? ":" : "."})${quote}`,
              ),
            },
          ],
        });
        if (result.isError) throw new Error();
        clearSelection();
        return true;
      } catch {
        showNotice(t.sendFailed);
        return false;
      }
    },
    [picked, clearSelection, showNotice, t],
  );

  const copy = useCallback(async () => {
    const text = picked?.selection.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The sandbox may deny the async clipboard; the live selection still copies.
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [picked]);

  const goToPage = useCallback((n: number) => viewer.current?.goToPage?.(n), []);

  const stepAgent = useCallback((index?: number) => {
    setAgent((current) => {
      if (!current) return current;
      const next = index ?? (current.index + 1) % current.targets.length;
      current.targets[next]?.scrollTo();
      pinned.current = true;
      return { ...current, index: next, visible: true };
    });
  }, []);

  // Pressing on the page (outside the callout) dismisses the agent's note.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element).closest(".callout, .chip, .pop, .pill")) return;
      setAgent((current) => (current?.visible ? { ...current, visible: false } : current));
    };
    canvas.addEventListener("pointerdown", onDown, true);
    return () => canvas.removeEventListener("pointerdown", onDown, true);
  }, [doc]);

  const docked = wide && !inline;
  const paged = Boolean(kind && PAGED.includes(kind));
  const drawerAvailable =
    Boolean(doc && ready && kind !== "xlsx") &&
    Boolean(viewer.current?.thumbnail || doc?.info.outline.length);

  useShellKeys({
    docRef,
    viewer,
    picked,
    addReference,
    openFind,
    closeFind,
    clearSelection,
    paged,
    page,
    goToPage,
    drawer,
    setDrawer,
    docked,
    find,
    agent,
    setAgent,
  });

  const openPath = useCallback(
    (target: string) => {
      setMenu(null);
      void call<ViewerSnapshot>("open_document", { path: target }).then(applySnapshot, (error) => {
        // The user asked for another file: close this one and say why that one did not open.
        loadSeq.current++;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      });
    },
    [applySnapshot, resetDocumentState, t],
  );

  const filePicker = useNativeFileInput(t, openPath, (error, name) =>
    setFailure(describeFailure(t, error, name)),
  );
  const Viewer = doc ? (VIEWERS[doc.info.kind]?.view ?? null) : null;
  const viewerProps = useMemo(
    () =>
      doc
        ? {
            bytes: doc.bytes,
            info: doc.info,
            blocks: doc.blocks,
            dark,
            glance: inline,
            onLocation: setLocation,
            onSelect,
            onRevealHit,
            onPage: setPage,
            onZoom: setZoom,
            onLink: (url: string) => void host.app.openLink({ url }).catch(() => undefined),
            onReady,
            onError: (error: Error) =>
              setFailure(describeFailure(t, error, docRef.current?.info.path ?? null)),
          }
        : null,
    // `t` only words errors; a locale change does not need a new viewer.
    [doc, dark, inline, onReady, onSelect, onRevealHit],
  );

  const showSkeleton = !failure && (Boolean(pending) || Boolean(doc && !ready));
  const nothing = !doc && !pending && !failure;
  const label = picked ? describeAt(picked.selection.at, t) : "";

  if (inline)
    return (
      <InlineShell
        appRef={appRef}
        canvasRef={canvasRef}
        t={t}
        path={path}
        info={doc?.info}
        kind={kind}
        showSkeleton={showSkeleton}
        failure={failure}
        nothing={nothing}
        onExpand={() =>
          void host.app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined)
        }
      >
        {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
      </InlineShell>
    );

  return (
    <div ref={appRef} className="app">
      {nothing ? null : find.open ? (
        <FindBar
          t={t}
          query={find.query}
          total={find.total}
          index={find.index}
          onQuery={queryFind}
          onStep={stepFind}
          onClose={closeFind}
        />
      ) : (
        <header className="docbar">
          {doc || pending || failure ? (
            <button
              type="button"
              className={`btn icon ${drawer.open && drawerAvailable ? "secondary" : "dim"}`}
              title={t.pagesAndOutline}
              aria-label={t.pagesAndOutline}
              aria-pressed={drawer.open && drawerAvailable}
              disabled={!drawerAvailable}
              hidden={kind === "xlsx"}
              onClick={() => setDrawer((state) => ({ ...state, open: !state.open }))}
            >
              <Icon name="panel-left" />
            </button>
          ) : null}
          <button
            type="button"
            className={`doctitle${menu === "switch" ? " open" : ""}`}
            title={path ?? undefined}
            aria-haspopup="menu"
            aria-expanded={menu === "switch"}
            aria-label={`${t.switchDocument}: ${path ?? ""}`}
            data-menu-trigger=""
            onClick={() => setMenu((value) => (value === "switch" ? null : "switch"))}
          >
            <span className="name">{path ? baseName(path) : t.title}</span>
            <Icon name="chevron-down" size={12} className="chev" />
          </button>
          <span className="spacer" />
          {doc && !failure ? (
            <>
              <button
                type="button"
                className="btn icon dim"
                title={`${t.find} (⌘F)`}
                aria-label={t.find}
                disabled={!ready}
                onClick={openFind}
              >
                <Icon name="search" />
              </button>
              <button
                type="button"
                className={`btn icon dim${menu === "more" ? " active" : ""}`}
                title={t.more}
                aria-label={t.more}
                aria-haspopup="menu"
                aria-expanded={menu === "more"}
                data-menu-trigger=""
                onClick={() => setMenu((value) => (value === "more" ? null : "more"))}
              >
                <Icon name="ellipsis" />
              </button>
            </>
          ) : null}
        </header>
      )}
      {changed ? (
        <ChangedBanner
          t={t}
          onReload={() => doc && void load(doc.info.path)}
          onDismiss={() => {
            dismissedRevision.current = changed;
            setChanged(null);
          }}
        />
      ) : null}
      {nothing ? (
        <EmptyState t={t} importing={filePicker.importing} onBrowse={filePicker.browse} />
      ) : (
        <div className="stage">
          {drawer.open && drawerAvailable && doc ? (
            <>
              {docked ? null : (
                <div
                  className="scrim"
                  onClick={() => setDrawer((state) => ({ ...state, open: false }))}
                />
              )}
              <Drawer
                t={t}
                info={doc.info}
                handle={viewer.current}
                page={paged ? page : null}
                tab={drawer.tab}
                docked={docked}
                onTab={(tab) => setDrawer((state) => ({ ...state, tab }))}
                onPage={(n) => {
                  goToPage(n);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
                onOutline={(at) => {
                  viewer.current?.goTo(at);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
              />
            </>
          ) : null}
          <div ref={canvasRef} className="canvas">
            {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
            {showSkeleton ? <Skeleton kind={kind} /> : null}
            {failure ? (
              <ErrorState
                t={t}
                title={failure.title}
                detail={failure.detail}
                onOpenAnother={filePicker.browse}
              />
            ) : null}
            {doc && ready && !failure && picked?.detail.user ? (
              <SelectionBar
                key={`${picked.selection.at}:${picked.selection.text.length}`}
                t={t}
                frame={canvasRef}
                locate={picked.detail.locate}
                text={picked.detail.text}
                label={label}
                quote={clip(picked.selection.text.replace(/\s+/g, " "), 60)}
                short={doc.info.kind === "xlsx"}
                mode={barMode}
                canAsk={Boolean(host.capabilities?.message)}
                copied={copied}
                onAdd={() => void addReference()}
                onAsk={() => setBarMode("ask")}
                onCopy={() => void copy()}
                onCancelAsk={() => setBarMode("bar")}
                onSend={ask}
              />
            ) : null}
            {agent?.visible && agent.targets[agent.index] && !failure ? (
              <AgentCallout
                t={t}
                frame={canvasRef}
                locate={agent.targets[agent.index].locate}
                note={agent.note}
                index={agent.index}
                total={agent.targets.length}
                onNext={() => stepAgent()}
                onClose={() => setAgent({ ...agent, visible: false })}
              />
            ) : null}
            {agent && offscreen ? (
              <OffscreenChip
                text={offscreenText(
                  t,
                  offscreen.indexes.map((i) => agent.targets[i].at),
                )}
                down={offscreen.down}
                raised={paged}
                onClick={() => stepAgent(offscreen.indexes[0])}
              />
            ) : null}
            {doc && ready && !failure && paged && page ? (
              <PagePill
                t={t}
                frame={canvasRef}
                page={page}
                zoom={kind && ZOOMABLE.includes(kind) ? zoom : null}
                onPage={goToPage}
                onZoom={(direction) => viewer.current?.zoom(direction)}
                onFit={() => viewer.current?.fit("width")}
              />
            ) : null}
            {notice ? <div className="chip notice">{notice}</div> : null}
          </div>
        </div>
      )}
      {menu === "switch" ? (
        <SwitchMenu
          t={t}
          recent={recent}
          currentPath={doc?.info.path}
          onOpen={openPath}
          onBrowse={() => {
            setMenu(null);
            filePicker.browse();
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "more" && doc ? (
        <MoreMenu
          t={t}
          zoomable={ZOOMABLE.includes(doc.info.kind)}
          zoomMode={zoom?.mode}
          onFit={(mode) => {
            viewer.current?.fit(mode);
            setMenu(null);
          }}
          onFind={openFind}
          onReload={() => {
            setMenu(null);
            void load(doc.info.path);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {filePicker.input}
    </div>
  );
}

const root = document.getElementById("root")!;
root.textContent = "";
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
void host.ready();
