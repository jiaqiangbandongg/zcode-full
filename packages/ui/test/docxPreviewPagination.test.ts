// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";
import { PreviewPaneOfficeDocxContent } from "@/previewPaneOfficeDocxContent.js";

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const SAME_SIZE_SECTION_DOCX_BASE64 =
  "UEsDBAoAAAAIALFL/FzXeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMECgAAAAAAsUv8XAAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgAsUv8XCAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMECgAAAAAAsUv8XAAAAAAAAAAAAAAAAAUAAAB3b3JkL1BLAwQKAAAACACxS/xctlr0wDUBAACuAgAAEQAAAHdvcmQvZG9jdW1lbnQueG1spVLLasMwELznK4zujaQ2JG6IHWiht0Kg7Qeo9sY2WFohbeKkX1/JD0j6uLSXZUazaHeG3WxPuk2O4HyDJmNyLlgCpsCyMVXG3l6fblKWeFKmVC0ayNgZPNvms023LrE4aDCUhB+MX3cZq4nsmnNf1KCVn6MFE7Q9Oq0oUFfxDl1pHRbgfRigW34rxJJr1RiWz5Ik/PqO5TnCntg8FBcL5Y8YttzwCGN1fbXXrXbXN3soKKBeGsTq5SPp4opS3oslC7gOeJnepYxf9T0rF0RCmzER21xT1TTidyRCPZIW9tN7DaoEl7GVSCPdI9IFrQ7UUzFNinuPG/YWdj9aGV0/hDh+N/3NKJ0thJlH1WbMwIl2qoIvDv+QhFwsLsOQC7m6zGOSh0jkSsj/pTIb2HAJEU2Xln8CUEsBAhQACgAAAAgAsUv8XNd5hOrxAAAAuAEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAKAAAAAACxS/xcAAAAAAAAAAAAAAAABgAAAAAAAAAAABAAAAAiAQAAX3JlbHMvUEsBAhQACgAAAAgAsUv8XCAbhuqyAAAALgEAAAsAAAAAAAAAAAAAAAAARgEAAF9yZWxzLy5yZWxzUEsBAhQACgAAAAAAsUv8XAAAAAAAAAAAAAAAAAUAAAAAAAAAAAAQAAAAIQIAAHdvcmQvUEsBAhQACgAAAAgAsUv8XLZa9MA1AQAArgIAABEAAAAAAAAAAAAAAAAARAIAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAAFAAUAIAEAAKgDAAAAAA==";

afterEach(() => {
  cleanup();
});

describe("DOCX preview pagination", () => {
  it("keeps same-size sections on separate pages with their own margins", async () => {
    const view = render(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: decodeBase64ToArrayBuffer(SAME_SIZE_SECTION_DOCX_BASE64),
        errorMessage: "unavailable",
        sourcePath: "/workspace/same-size-sections.docx",
      }),
    );

    await waitFor(() => {
      expect(view.container.querySelectorAll("section")).toHaveLength(2);
    });

    const [coverPage, bodyPage] = Array.from(
      view.container.querySelectorAll<HTMLElement>("section"),
    );
    expect(coverPage?.style.padding).toBe("0pt");
    expect(bodyPage?.style.padding).toBe("72pt 70.85pt 72pt 85.05pt");
    expect(coverPage?.textContent).toContain("Cover");
    expect(bodyPage?.textContent).toContain("Body");
    expect(getComputedStyle(coverPage!).boxShadow).toBe(
      "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)",
    );
  });
});
