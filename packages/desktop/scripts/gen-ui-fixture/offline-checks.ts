import assert from "node:assert/strict";
import { app } from "electron";

/** 独立 profile 中，在第一次导航前禁网；不覆盖生产 onBeforeRequest 闸门。 */
export function installOfflineChecks() {
  const localScripts = new Set<string>();
  const networkRequests: string[] = [];
  app.on("session-created", (session) => {
    session.enableNetworkEmulation({ offline: true });
    session.webRequest.onBeforeSendHeaders(
      { urls: ["http://*/*", "https://*/*"] },
      (details, callback) => {
        networkRequests.push(details.url);
        callback({ cancel: true });
      },
    );
    session.webRequest.onCompleted({ urls: ["zcode-sandbox://*/*"] }, (details) => {
      if (details.url.includes("/__zcode__/vendor/")) localScripts.add(details.url);
    });
  });
  return {
    async check(read: (code: string) => Promise<any>) {
      assert.equal(await read("typeof d3"), "undefined", "D3 must stay demand-loaded");
      await read(`new Promise((resolve,reject)=>{
        const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';
        s.onload=resolve;s.onerror=()=>reject(new Error('Offline D3 failed'));document.head.append(s);
      })`);
      assert.equal(await read("d3.version"), "7.9.0");
      assert.equal(
        await read(`(() => {
        const svg=d3.select(document.body).append('svg');
        svg.selectAll('rect').data([2,4,6]).join('rect').attr('width',d=>d*10);
        const width=svg.select('rect:last-child').attr('width');svg.remove();return width;
      })()`),
        "60",
      );
      const loaded = [...localScripts].map((url) => url.split("/").at(-1));
      for (const file of [
        "floating-ui-core-1.7.3.min.js",
        "floating-ui-dom-1.7.4.min.js",
        "lucide-1.17.0.js",
        "d3-7.9.0.min.js",
      ])
        assert.ok(loaded.includes(file), `${file} did not load locally`);
      assert.deepEqual(networkRequests, [], "Preset resources must never reach HTTP headers");
    },
    assertNoNetwork: () => assert.deepEqual(networkRequests, []),
  };
}
