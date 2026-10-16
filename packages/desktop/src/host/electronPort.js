/**
 * 将 Electron MessagePortMain 适配为 RPC 层的 MessagePortLike 接口。
 *
 * Electron 的 MessagePortMain 使用 Node EventEmitter 风格 (.on/.off)，
 * 而 MessagePortLike 使用 Web 标准风格 (addEventListener/removeEventListener)。
 * 此适配器弥合两者差异，使 MessagePortProtocol 可以直接在 utilityProcess 中使用。
 */
export function wrapElectronPort(port) {
    return {
        addEventListener(_type, listener) {
            // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发
            port.on("message", listener);
        },
        removeEventListener(_type, listener) {
            port.off("message", listener);
        },
        postMessage(data) {
            port.postMessage(data);
        },
        start() {
            port.start();
        },
        close() {
            port.close();
        },
    };
}
//# sourceMappingURL=electronPort.js.map