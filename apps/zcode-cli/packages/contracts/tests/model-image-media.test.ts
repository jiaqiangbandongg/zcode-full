import { describe, expect, it } from "vitest";

import { parseImageDataUrl } from "../src/model/index.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("model image media contracts", () => {
  it("exports image data URL parsing from the model subpath", () => {
    const parsed = parseImageDataUrl(`data:image/png;base64,${PNG_1X1_BASE64}`);

    expect(parsed?.mediaType).toBe("image/png");
    expect(parsed?.data.length).toBeGreaterThan(0);
  });
});
