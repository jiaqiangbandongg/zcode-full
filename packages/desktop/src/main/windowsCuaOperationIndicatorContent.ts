import type { Locale } from "@zcode/shared";

/**
 * Windows CUA 操作提示条的呈现层：文案、尺寸与 HTML。
 *
 * 与窗口生命周期分开，是因为两者的变更理由不同——这里跟着文案与视觉走，
 * `windowsCuaOperationIndicator.ts` 跟着显示/隐藏时机与 Electron 窗口行为走。
 */

const INDICATOR_CARD_HEIGHT = 38;
export const INDICATOR_CARD_TOP_OFFSET = 12;
export const INDICATOR_SHADOW_INSET = { top: 6, right: 8, bottom: 12, left: 8 } as const;

export function indicatorCopy(locale: Locale): { text: string; width: number } {
  return locale === "zh-CN"
    ? { text: "ZCode 正在操作电脑", width: 234 }
    : { text: "ZCode is controlling your computer", width: 308 };
}

export function indicatorWindowSize(locale: Locale): { width: number; height: number } {
  const { width } = indicatorCopy(locale);
  return {
    width: width + INDICATOR_SHADOW_INSET.left + INDICATOR_SHADOW_INSET.right,
    height: INDICATOR_SHADOW_INSET.top + INDICATOR_CARD_HEIGHT + INDICATOR_SHADOW_INSET.bottom,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function indicatorHtml(locale: Locale): string {
  const copy = indicatorCopy(locale);
  return `<!doctype html>
<html lang="${locale}" data-state="active">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: flex; align-items: center; justify-content: center; padding: 6px 8px 12px; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
    .indicator {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; height: 38px; padding: 0 18px;
      color: #202124; background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(15, 23, 42, 0.14); border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
      font-size: 13px; font-weight: 600; line-height: 1; white-space: nowrap;
      opacity: 1; transform: translateY(0);
      transition: opacity 120ms ease, transform 120ms ease;
      animation: enter 140ms ease-out both;
    }
    .dots { display: flex; align-items: center; gap: 3px; }
    .dot { width: 4px; height: 4px; border-radius: 50%; background: #64748b; animation: pulse 1.2s ease-in-out infinite; }
    .dot:nth-child(2) { animation-delay: 120ms; }
    .dot:nth-child(3) { animation-delay: 240ms; }
    html[data-state="leaving"] .indicator { opacity: 0; transform: translateY(-6px); }
    @keyframes enter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%, 70%, 100% { opacity: .35; transform: scale(.8); } 35% { opacity: 1; transform: scale(1); } }
    @media (prefers-color-scheme: dark) {
      .indicator { color: #f8fafc; background: rgba(35, 38, 43, 0.96); border-color: rgba(255, 255, 255, 0.14); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28); }
      .dot { background: #a8b3c4; }
    }
    @media (prefers-reduced-motion: reduce) {
      .indicator, .dot { animation: none; transition: opacity 1ms linear; transform: none; }
      html[data-state="leaving"] .indicator { transform: none; }
    }
  </style>
</head>
<body><div class="indicator" role="status" aria-live="polite"><span class="dots" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span>${escapeHtml(copy.text)}</span></div></body>
</html>`;
}

export function indicatorDataUrl(locale: Locale): string {
  return `data:text/html;base64,${Buffer.from(indicatorHtml(locale), "utf8").toString("base64")}`;
}
