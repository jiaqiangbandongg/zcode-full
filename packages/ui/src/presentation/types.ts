export interface PresentationPageSize {
  width: number;
  height: number;
}

export interface PresentationRenderOptions {
  onNavigate?: (target: { pageIndex?: number; url?: string }) => void;
  onNodeError?: (nodeId: string, error: unknown) => void;
}

export interface PresentationRenderHandle {
  readonly ready: Promise<void>;
  dispose(): void;
}

export type PresentationElementNodeType =
  | "shape"
  | "picture"
  | "chart"
  | "table"
  | "table-cell";

export interface PresentationElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresentationPageElement {
  slideIndex: number;
  slidePart: string;
  nodeId: string;
  nodePath?: string;
  nodeName: string;
  nodeType: PresentationElementNodeType;
  text?: string;
  bounds: PresentationElementBounds;
  zIndex: number;
  rowIndex?: number;
  cellIndex?: number;
}

export interface PresentationPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: PresentationPageSize;
  getPageElements(pageIndex: number): readonly PresentationPageElement[];
  renderPage(
    pageIndex: number,
    container: HTMLElement,
    options?: PresentationRenderOptions,
  ): PresentationRenderHandle;
  dispose(): void;
}

export interface PresentationPreviewEngine {
  open(data: ArrayBuffer): Promise<PresentationPreviewDocument>;
}

/** 后续 DOM 编辑能力的标记边界；第一期不定义尚未验证的编辑命令语义。 */
export interface PresentationEditEngine {
  readonly capability: "dom-edit";
}

/** 后续 DOM -> PPTX 导出能力的标记边界；第一期不承诺原文件无损写回。 */
export interface PresentationExportEngine {
  readonly capability: "dom-to-pptx";
}

export interface PresentationCapabilities {
  preview: PresentationPreviewEngine;
  edit?: PresentationEditEngine;
  export?: PresentationExportEngine;
}
