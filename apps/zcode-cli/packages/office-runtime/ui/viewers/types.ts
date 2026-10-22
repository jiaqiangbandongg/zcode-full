import type { DocumentInfo, DocxBlockKey, Selection, ShowTarget } from "#office/contract.ts";

export interface Capture {
  /** PNG as base64 (no data: prefix). */
  data: string;
  at: string;
  width: number;
  height: number;
}

/** Current on-screen box of something in the document, or null when it is not rendered. */
export type Locate = () => DOMRect | null;

export type FitMode = "width" | "page" | "actual";

/** Zoom as the page/zoom control shows it: a fit mode, or a percentage of actual size. */
export interface ZoomState {
  mode: FitMode | null;
  percent: number;
}

export interface PageState {
  /** 1-based page (or slide) at the top of the view. */
  current: number;
  count: number;
}

/** How a selection was made, for the selection bar. */
export interface SelectionDetail {
  /** True for a text selection (the bar offers Copy); false for a clicked block, page or range. */
  text: boolean;
  locate: Locate;
  /** False when the selection changed without the user acting on it (e.g. a sheet's first cell). */
  user: boolean;
}

/** One agent target after it was resolved in the rendered document, in the order given. */
export interface RevealedTarget {
  at: string;
  locate: Locate;
  scrollTo(): void;
}

/** Imperative interface the shell uses to drive a viewer. */
export interface ViewerHandle {
  /** Mark the targets, scroll to the first and return where each one is. */
  reveal(targets: ShowTarget[]): Promise<RevealedTarget[]>;
  clearReveal(): void;
  /** Scroll to a locator without marking it (outline entries). */
  goTo(at: string): void;
  /** Render a location (null = what is visible) to an image. */
  capture(at: string | null, maxWidth: number): Promise<Capture>;
  zoom(direction: 1 | -1): void;
  fit(mode: FitMode): void;
  /** Paint every match of `query` and return how many there are. */
  find(query: string): Promise<number>;
  /** Make match `index` (0-based) current and scroll to it. */
  findGo(index: number): void;
  clearFind(): void;
  /** Clear the user's selection (DOM selection and block outline). */
  clearSelection(): void;
  /** Paged viewers (pdf, docx, pptx). */
  goToPage?(page: number): void;
  /** Small rendering of a page or slide for the pages drawer. */
  thumbnail?(page: number, width: number): Promise<HTMLElement>;
}

export interface ViewerProps {
  bytes: ArrayBuffer;
  info: DocumentInfo;
  blocks?: DocxBlockKey[];
  dark: boolean;
  /** A short, non-interactive preview (inline card): first pages only, no scrolling. */
  glance?: boolean;
  /** Visible location changed (topmost page / slide / block, or active sheet + cell). */
  onLocation(at: string): void;
  /** The user selected something (click or text selection), or cleared it. */
  onSelect(selection: Selection | null, detail?: SelectionDetail): void;
  /**
   * The user clicked one of the agent's marks (a quote, block, shape or cell range; not a whole
   * page or slide). `index` is the target's position in the last `reveal` result. Returns true
   * when the shell showed the note; otherwise the click selects as usual.
   */
  onRevealHit?(index: number): boolean;
  onPage?(state: PageState): void;
  onZoom?(state: ZoomState): void;
  onLink(url: string): void;
  onReady(): void;
  onError(error: Error): void;
}

/** Zoom steps (percent of actual size), as browsers and ZCode's PDF preview use. */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

export function nextZoom(percent: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > percent + 0.5) ?? 400;
  return [...ZOOM_STEPS].reverse().find((step) => step < percent - 0.5) ?? 25;
}
