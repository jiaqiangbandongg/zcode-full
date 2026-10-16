import plugin from "tailwindcss/plugin";
import flattenColorPalette from "tailwindcss/lib/util/flattenColorPalette";

// 颜色类同时携带图标绘制信息，确保父按钮、嵌套颜色和 Tailwind 状态使用同一条继承链。
export default plugin(({ matchUtilities, theme, addBase, addUtilities }) => {
  matchUtilities(
    {
      text: (value) => {
        if (
          [
            "inherit",
            "currentColor",
            "currentcolor",
            "var(--color-inherit)",
            "var(--color-current)",
          ].includes(value)
        ) {
          return { "--lucide-stroke": "inherit", "--lucide-filter": "inherit" };
        }
        // Tailwind 将 /50 等颜色修饰符传成 color-mix；保留它的额外 alpha。
        const mixed = value.match(
          /^color-mix\(in oklab, (var\(--color-foreground-subt(?:le|lest)\)) ([\d.]+)%, transparent\)$/,
        );
        const color = mixed?.[1] ?? value;
        const tone =
          color === "var(--color-foreground-subtle)"
            ? "0.6"
            : color === "var(--color-foreground-subtlest)"
              ? "var(--lucide-subtlest-opacity)"
              : null;
        const alpha = mixed ? `calc(${tone} * ${Number(mixed[2]) / 100})` : tone;
        return {
          "--lucide-stroke": tone ? "rgb(from currentColor r g b / 1)" : "currentColor",
          "--lucide-filter": tone ? `opacity(${alpha})` : "initial",
        };
      },
    },
    {
      // 用 token 身份判断层级，不能比较构建时展开的色值：深浅主题会在运行时覆盖它。
      values: Object.fromEntries(
        Object.keys(flattenColorPalette(theme("colors"))).map((name) => [
          name,
          `var(--color-${name})`,
        ]),
      ),
      type: "color",
    },
  );
  const relativeColorSupport = "@supports (color: rgb(from red r g b / 1))";
  addBase({
    [relativeColorSupport]: {
      // 描边必须先不透明绘制，再对整个 SVG 合成。filter opacity 与已有 opacity-* 独立相乘。
      // 限定 Lucide 默认描边入口，其他 SVG / 自定义描边不参与。
      'svg.lucide[stroke="currentColor"]': {
        stroke: "var(--lucide-stroke, currentColor)",
        filter: "var(--lucide-filter, none)",
      },
      'svg.lucide[stroke="currentColor"][fill="currentColor"]': {
        fill: "var(--lucide-stroke, currentColor)",
      },
    },
  });
  // 实心状态点和停止按钮也要先用不透明填充；非 Lucide 的 fill-current 沿用原值。
  addUtilities({
    ".fill-current": {
      [relativeColorSupport]: {
        '&:is(.lucide):where(svg[stroke="currentColor"])': {
          fill: "var(--lucide-stroke, currentColor)",
        },
      },
    },
  });
});
