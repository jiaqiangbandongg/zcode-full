import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCloudContentMockServer } from "./cloud-content-mock.mjs";

test("HTTP mock returns a real ZIP with matching integrity and tracks requests", async () => {
  const mock = await createCloudContentMockServer();
  try {
    const response = await fetch(`${mock.url}/dialog?locale=en-US`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.locale, "en-US");
    assert.equal(payload.dialog.description.format, "html");
    const bundle = payload.dialog.hero.bundle;
    assert.equal(bundle.format, "zip");
    assert.equal(bundle.entry, "index.html");
    const bytes = Buffer.from(await (await fetch(bundle.url)).arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(bytes.length, bundle.sizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), bundle.sha256);
    assert.equal((await fetch(`${mock.url}/missing`)).status, 404);
    assert.equal(mock.requests.filter((url) => url.startsWith("/bundles/")).length, 1);
  } finally {
    await mock.close();
  }
});

test("provides real image, video and Lottie resources plus a feature scenario", async () => {
  const mock = await createCloudContentMockServer();
  try {
    for (const type of ["image", "video", "lottie"]) {
      const payload = await (
        await fetch(`${mock.url}/dialog?type=${type}&scenario=feature&locale=en-US`)
      ).json();
      assert.equal(payload.dialog.hero.type, type);
      assert.equal(payload.kind, "feature");
      const response = await fetch(payload.dialog.hero.src);
      assert.equal(response.status, 200);
      if (type === "video")
        assert.equal(
          Buffer.from(await response.arrayBuffer())
            .subarray(0, 4)
            .toString("hex"),
          "1a45dfa3",
        );
      else if (type === "lottie") assert.equal((await response.json()).layers.length, 1);
      else assert.match(await response.text(), /<svg/);
    }
  } finally {
    await mock.close();
  }
});
