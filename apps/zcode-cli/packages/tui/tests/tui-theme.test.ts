import assert from "node:assert/strict";
import test from "node:test";
import { ContentPane } from "../src/app-transcript-components.js";
import {
  LIGHT_TUI_THEME,
  activeTuiTheme,
  getActiveTuiThemeMode,
  inferThemeModeFromTerminalColors,
  resolveTuiThemeMode,
  setActiveTuiThemeMode,
} from "../src/theme/index.js";

test("resolves theme preferences against terminal mode", () => {
  assert.equal(resolveTuiThemeMode("dark", "light"), "dark");
  assert.equal(resolveTuiThemeMode("light", "dark"), "light");
  assert.equal(resolveTuiThemeMode("auto", "light"), "light");
  assert.equal(resolveTuiThemeMode("auto", null), "dark");
  assert.equal(resolveTuiThemeMode(undefined, "light"), "light");
});

test("infers terminal theme mode from terminal background colors", () => {
  assert.equal(inferThemeModeFromTerminalColors(terminalColors("#ffffff")), "light");
  assert.equal(inferThemeModeFromTerminalColors(terminalColors("#000000")), "dark");
  assert.equal(inferThemeModeFromTerminalColors(terminalColors(null)), null);
});

test("active theme controls legacy component colors", () => {
  try {
    setActiveTuiThemeMode("light");
    const style = reactElementStyle(ContentPane({ focused: false, messages: [] }));

    assert.equal(getActiveTuiThemeMode(), "light");
    assert.equal(activeTuiTheme().mode, "light");
    assert.equal(style.backgroundColor, LIGHT_TUI_THEME.background);
  } finally {
    setActiveTuiThemeMode("dark");
  }
});

function terminalColors(defaultBackground: string | null) {
  return {
    cursorColor: null,
    defaultBackground,
    defaultForeground: null,
    highlightBackground: null,
    highlightForeground: null,
    mouseBackground: null,
    mouseForeground: null,
    palette: [defaultBackground],
    tekBackground: null,
    tekForeground: null,
  };
}

function reactElementStyle(node: unknown): Record<string, unknown> {
  assert.ok(typeof node === "object" && node !== null && "props" in node);
  const element = node as { props?: { style?: Record<string, unknown> } };
  return element.props?.style ?? {};
}
