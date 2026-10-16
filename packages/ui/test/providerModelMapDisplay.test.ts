import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { JsonSlotEditor } from "@/settings/model-provider-section/ProviderModelMetadataFields.js";

describe("F98-03 Map 展示不重排源字符串", () => {
  it("继承 placeholder 保留换行；Personal value 保留用户空白，查看不触发 onChange", () => {
    const inherited = '{\n  "thinking": {\n    "type": "disabled"\n  }\n}';
    const personal = '{  "thinking" : {"type":"disabled"} }';
    const onChange = vi.fn();
    for (const value of ["", personal]) {
      const html = renderToStaticMarkup(
        createElement(JsonSlotEditor, {
          label: "推理参数映射",
          value,
          effectiveValue: inherited,
          onChange,
        }),
      );
      expect(html).toContain(inherited.replaceAll('"', "&quot;"));
      if (value) expect(html).toContain(personal.replaceAll('"', "&quot;"));
      expect(onChange).not.toHaveBeenCalled();
    }
  });
});
