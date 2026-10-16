import type { GenUiReference, GenUiWidgetState, GenUiTweakMessage } from "./contract.js";
export const exampleGenUiReference: GenUiReference = {
  path: "/workspace/charts/sales.html",
  title: "Sales",
};
export const exampleGenUiState: GenUiWidgetState = {
  modelContent: { month: 6 },
  privateContent: { tab: "chart" },
};
export const exampleGenUiTweakRegistration: GenUiTweakMessage = {
  type: "register",
  registrationId: "tweak-1",
  targets: [
    {
      id: "1",
      label: "Player",
      selector: "#player",
      tagName: "div",
      rect: { x: 0, y: 0, width: 200, height: 100 },
    },
  ],
  annotationControls: {
    controlsMode: "replace",
    controls: [
      {
        type: "range",
        callback: "tweak-1-1",
        label: "Radius",
        currentValue: 12,
        min: 0,
        max: 40,
        step: 1,
      },
    ],
  },
};
