import type { WebContents } from "electron";

export function evaluateGuest(guest: WebContents, code: string): Promise<any> {
  const frame = guest.mainFrame.frames.find((candidate) => candidate.url.includes("/instance/"))!;
  let closed!: () => void;
  const destroyed = new Promise<never>((_resolve, reject) => {
    closed = () => reject(new Error("fixture page was destroyed"));
    guest.once("destroyed", closed);
  });
  // Chromium 不保证已销毁 frame 的 executeJavaScript Promise 回包；以真实销毁事件结束观察。
  return Promise.race([frame.executeJavaScript(code), destroyed]).finally(() =>
    guest.removeListener("destroyed", closed),
  );
}
