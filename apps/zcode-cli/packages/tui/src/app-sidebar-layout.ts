import { RGBA } from "@mbears/opentui-core";
import { useTerminalDimensions } from "@mbears/opentui-react";
import { useCallback, useMemo, useState } from "react";

export const SIDEBAR_WIDTH = 42;
export const SIDEBAR_HORIZONTAL_PADDING_COLUMNS = 1;
export const SIDEBAR_CONTENT_WIDTH = SIDEBAR_WIDTH - SIDEBAR_HORIZONTAL_PADDING_COLUMNS * 2;
const SIDEBAR_AUTO_VISIBLE_BREAKPOINT = 120;
export const SIDEBAR_OVERLAY_BACKGROUND = RGBA.fromInts(0, 0, 0, 70);

type SidebarPreference = "auto" | "hidden";
export type SidebarSectionId = "apis" | "mcp" | "modifiedFiles" | "todos" | "subagents";
export type SidebarSectionExpansion = Record<SidebarSectionId, boolean>;

type SidebarControllerState = {
  narrowOverlayOpen: boolean;
  preference: SidebarPreference;
  sections: SidebarSectionExpansion;
};

export type SidebarLayout = {
  overlay: boolean;
  reservedWidth: number;
  visible: boolean;
  wide: boolean;
};

type SidebarController = {
  layout: SidebarLayout;
  sections: SidebarSectionExpansion;
  terminalWidth: number;
  toggleSidebarSection: (section: SidebarSectionId) => boolean;
  toggleSidebar: () => boolean;
};

export const DEFAULT_SIDEBAR_STATE: SidebarControllerState = {
  narrowOverlayOpen: false,
  preference: "auto",
  sections: {
    subagents: true,
    apis: true,
    mcp: true,
    modifiedFiles: true,
    todos: true,
  },
};

export function useSidebarController(): SidebarController {
  const { width } = useTerminalDimensions();
  const [state, setState] = useState<SidebarControllerState>(DEFAULT_SIDEBAR_STATE);
  const terminalWidth = Math.floor(width);
  const layout = useMemo(
    () => sidebarLayoutForTerminal(terminalWidth, state),
    [state, terminalWidth],
  );
  const toggleSidebar = useCallback(() => {
    const nextState = toggleSidebarState(state, terminalWidth);
    const nextLayout = sidebarLayoutForTerminal(terminalWidth, nextState);

    setState(nextState);
    return nextLayout.visible;
  }, [state, terminalWidth]);
  const toggleSidebarSection = useCallback(
    (section: SidebarSectionId) => {
      const sections = toggleSidebarSectionState(state.sections, section);
      setState({ ...state, sections });
      return sections[section];
    },
    [state],
  );

  return {
    layout,
    sections: state.sections,
    terminalWidth,
    toggleSidebarSection,
    toggleSidebar,
  };
}

export function sidebarLayoutForTerminal(
  terminalWidth: number,
  state: SidebarControllerState,
): SidebarLayout {
  const wide = isWideSidebarTerminal(terminalWidth);
  const visible = state.narrowOverlayOpen || (state.preference === "auto" && wide);
  const overlay = visible && !wide;

  return {
    overlay,
    reservedWidth: visible && !overlay ? SIDEBAR_WIDTH : 0,
    visible,
    wide,
  };
}

export function toggleSidebarState(
  state: SidebarControllerState,
  terminalWidth: number,
): SidebarControllerState {
  const layout = sidebarLayoutForTerminal(terminalWidth, state);
  if (layout.visible) {
    return {
      narrowOverlayOpen: false,
      preference: "hidden",
      sections: state.sections,
    };
  }

  return {
    narrowOverlayOpen: !layout.wide,
    preference: "auto",
    sections: state.sections,
  };
}

function isWideSidebarTerminal(terminalWidth: number): boolean {
  return Math.floor(terminalWidth) > SIDEBAR_AUTO_VISIBLE_BREAKPOINT;
}

export function toggleSidebarSectionState(
  sections: SidebarSectionExpansion,
  section: SidebarSectionId,
): SidebarSectionExpansion {
  return {
    ...sections,
    [section]: !sections[section],
  };
}
