/** 既有入口的类型契约；不创建第二份状态或转发实现。 */
export interface EmbeddedBrowserPermissionContract {
  applyEmbeddedBrowserPermissionPolicy: typeof import("@desktop/main/embeddedBrowserPermissionPolicy.js").applyEmbeddedBrowserPermissionPolicy;
}
