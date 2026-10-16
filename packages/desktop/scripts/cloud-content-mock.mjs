import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import yazl from "yazl";

/** 显式启动的开发 fixture 服务，不由生产 App 自动开启。 */
export async function createCloudContentMockServer({ port = 0 } = {}) {
  const video = Buffer.from(
    await readFile(
      new URL("../../ui/src/assets/cloud-content/preview.webm.base64", import.meta.url),
      "utf8",
    ),
    "base64",
  );
  const lottie = {
    v: "5.13.0",
    fr: 30,
    ip: 0,
    op: 60,
    w: 400,
    h: 300,
    nm: "Cloud content demo",
    ddd: 0,
    assets: [],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: "Rotating square",
        sr: 1,
        ks: {
          o: { a: 0, k: 100 },
          r: {
            a: 1,
            k: [
              { t: 0, s: [0], e: [360], i: { x: [0.67], y: [1] }, o: { x: [0.33], y: [0] } },
              { t: 60, s: [360] },
            ],
          },
          p: { a: 0, k: [200, 150, 0] },
          a: { a: 0, k: [0, 0, 0] },
          s: { a: 0, k: [100, 100, 100] },
        },
        ao: 0,
        shapes: [
          {
            ty: "rc",
            d: 1,
            s: { a: 0, k: [110, 110] },
            p: { a: 0, k: [0, 0] },
            r: { a: 0, k: 14 },
          },
          { ty: "fl", c: { a: 0, k: [0.2, 0.6, 1, 1] }, o: { a: 0, k: 100 }, r: 1 },
        ],
        ip: 0,
        op: 60,
        st: 0,
        bm: 0,
      },
    ],
  };
  const hero = await readFile(
    new URL("../../ui/src/assets/cloud-content/weekend-plan-hero.html", import.meta.url),
  );
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../ui/src/components/cloud-content-dialog/mocks/weekendPlanResultDialog.zh-CN.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const zip = new yazl.ZipFile();
  zip.addBuffer(hero, "index.html", { mtime: new Date("2026-01-01T00:00:00Z") });
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests = [];
  let baseUrl;
  const server = createServer((req, res) => {
    requests.push(req.url ?? "/");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? "/", baseUrl);
    if (url.pathname === "/preview.webm") {
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/u);
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(video.length - 1, range[2] ? Number(range[2]) : video.length - 1);
        if (start > end || start >= video.length) {
          res.writeHead(416).end();
          return;
        }
        res
          .writeHead(206, {
            "Content-Type": "video/webm",
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${video.length}`,
            "Content-Length": end - start + 1,
          })
          .end(video.subarray(start, end + 1));
      } else
        res
          .writeHead(200, {
            "Content-Type": "video/webm",
            "Content-Length": video.length,
            "Accept-Ranges": "bytes",
          })
          .end(video);
      return;
    }
    if (url.pathname === "/preview.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(lottie));
      return;
    }
    if (["/preview-light.svg", "/preview-dark.svg"].includes(url.pathname)) {
      const dark = url.pathname.includes("dark");
      res
        .writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        })
        .end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="${dark ? "#14243c" : "#e8f1ff"}"/><rect x="140" y="65" width="120" height="120" rx="20" fill="#398deb"/><text x="200" y="240" text-anchor="middle" font-family="sans-serif" font-size="22" fill="${dark ? "#ffffff" : "#14243c"}">Cloud content preview</text></svg>`,
        );
      return;
    }
    if (url.pathname === `/bundles/${sha256}.zip`) {
      res
        .writeHead(200, { "Content-Type": "application/zip", "Content-Length": bytes.length })
        .end(bytes);
      return;
    }
    if (url.pathname === "/dialog") {
      const payload = structuredClone(fixture);
      payload.dialog.hero.bundle = {
        format: "zip",
        url: `${baseUrl}/bundles/${sha256}.zip`,
        entry: "index.html",
        sha256,
        sizeBytes: bytes.length,
      };
      payload.dialog.description = {
        format: "html",
        text: "<p><b>GLM-5.3-Flash</b> 已可使用。</p><p>这是本地 HTTP mock，不会领取真实套餐。</p>",
      };
      if (url.searchParams.get("locale") === "en-US") {
        payload.locale = "en-US";
        payload.dialog.title = "Your Weekend Plan is ready";
        payload.dialog.description.text =
          "<p><b>GLM-5.3-Flash</b> is ready to use.</p><p>This local HTTP mock does not claim a real plan.</p>";
        payload.dialog.buttons[0].label = "Model settings";
        payload.dialog.buttons[1].label = "Copy & share";
        payload.dialog.hero.data.endsAtPrefix = "Valid until";
        payload.dialog.hero.data.replayLabel = "Replay";
        payload.dialog.hero.data.benefits = ["GLM-5.3-Flash daily quota"];
        payload.actions["copy-share"].text = "Try the new ZCode experience.";
      }
      const english = payload.locale === "en-US";
      const scenario = url.searchParams.get("scenario");
      if (scenario === "feature") {
        payload.id = "new-feature-dialog";
        payload.kind = "feature";
        payload.dialog.title = english ? "Meet the new feature" : "认识新功能";
        payload.dialog.description.text = english
          ? "<p>A <b>new feature</b> is ready.</p><ul><li>Cloud-driven content</li><li>Interactive previews</li></ul>"
          : "<p><b>新功能</b>已准备就绪。</p><ul><li>云端内容</li><li>交互预览</li></ul>";
      }
      if (scenario === "bad_hash") payload.dialog.hero.bundle.sha256 = "0".repeat(64);
      const image = {
        type: "image",
        src: `${baseUrl}/preview-light.svg`,
        darkSrc: `${baseUrl}/preview-dark.svg`,
        alt: english ? "Feature preview" : "功能预览",
        fit: "contain",
      };
      switch (url.searchParams.get("type")) {
        case "image":
          payload.dialog.hero = image;
          break;
        case "video":
          payload.dialog.hero = {
            type: "video",
            src: `${baseUrl}/preview.webm`,
            poster: image.src,
            muted: true,
            autoplay: true,
            loop: true,
            fit: "contain",
          };
          break;
        case "lottie":
          payload.dialog.hero = {
            type: "lottie",
            src: `${baseUrl}/preview.json`,
            autoplay: true,
            loop: true,
            speed: 1,
            fallback: image,
          };
          break;
      }
      payload.dialog.buttons.push({
        id: "close-preview",
        label: english ? "Close preview" : "关闭预览",
        variant: "link",
        actionId: "close-preview",
      });
      payload.actions["close-preview"] = { type: "close" };
      res
        .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: baseUrl,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await createCloudContentMockServer({
    port: Number(process.env.CLOUD_CONTENT_MOCK_PORT ?? 4319),
  });
  console.log(`Cloud content mock: ${mock.url}/dialog`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void mock.close();
    });
}
