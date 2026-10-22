import { TITLE } from "#office/wording.ts";
import { readText } from "#ui/assets.ts";
import { getHost } from "#ui/host.ts";

// Small loader inlined in panel.html: connect once, then pull the UI bundle through MCP resources
// (one large HTML resource would exceed host limits) and run it in the same page and App.
(async () => {
  getHost();
  const manifest = JSON.parse(await readText("assets.json")) as { scripts: string[] };
  const [css, ...parts] = await Promise.all([
    readText("panel.css"),
    ...manifest.scripts.map(readText),
  ]);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const script = document.createElement("script");
  script.textContent = parts.join("");
  document.body.append(script);
})().catch((error: Error) => {
  const root = document.getElementById("root");
  if (root) root.textContent = `${TITLE} failed to load: ${error.message}`;
});
