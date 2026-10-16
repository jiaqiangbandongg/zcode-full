/** 在 Electron 注册 webview 前于主世界执行；函数不能捕获 preload 的闭包。 */
export function enableSandboxRetainedMoves(): boolean {
  if (typeof Element.prototype.moveBefore !== "function") return false;
  const define = customElements.define;
  customElements.define = function (name, constructor, options) {
    if (name === "webview") {
      const prototype = constructor.prototype as HTMLElement & {
        connectedCallback(): void;
        disconnectedCallback(): void;
        connectedMoveCallback?: () => void;
      };
      // Electron 41 未注册移动回调，moveBefore 仍会走断开/重连并清空 guest。
      // 仅标记的沙箱跳过这对回调；真正 remove 与普通 webview 保持原行为。
      if (!prototype.connectedMoveCallback) {
        const connect = prototype.connectedCallback,
          disconnect = prototype.disconnectedCallback;
        prototype.connectedMoveCallback = function () {
          if (this.hasAttribute("data-zcode-retained-sandbox")) return;
          disconnect.call(this);
          connect.call(this);
        };
      }
      customElements.define = define;
    }
    return define.call(this, name, constructor, options);
  };
  return true;
}
