import { describe, expect, it } from "vitest";
import {
  clampDiagramScale,
  fitDiagramToViewport,
  panDiagram,
  zoomDiagramAtPoint,
} from "../src/lib/diagramViewport.js";

describe("diagramViewport", () => {
  it("clamps scale to the supported preview range", () => {
    expect(clampDiagramScale(0.01)).toBe(0.25);
    expect(clampDiagramScale(2)).toBe(2);
    expect(clampDiagramScale(20)).toBe(4);
    expect(clampDiagramScale(Number.NaN)).toBe(1);
  });

  it("keeps the zoom focus point stable", () => {
    const next = zoomDiagramAtPoint(
      { scale: 1, translateX: 10, translateY: 20 },
      { x: 110, y: 120 },
      2,
    );

    expect(next).toEqual({
      scale: 2,
      translateX: -90,
      translateY: -80,
    });
  });

  it("pans without changing scale", () => {
    expect(panDiagram({ scale: 1.5, translateX: 10, translateY: 20 }, { x: -4, y: 8 })).toEqual({
      scale: 1.5,
      translateX: 6,
      translateY: 28,
    });
  });

  it("fits large diagrams into the available viewport", () => {
    const fitted = fitDiagramToViewport({
      diagramHeight: 800,
      diagramWidth: 1200,
      padding: 20,
      viewportHeight: 500,
      viewportWidth: 700,
    });

    expect(fitted.scale).toBeCloseTo(0.55);
    expect(fitted.translateX).toBeCloseTo(20);
    expect(fitted.translateY).toBeCloseTo(30);
  });

  it("scales smaller diagrams up to fit the preview viewport", () => {
    const fitted = fitDiagramToViewport({
      diagramHeight: 200,
      diagramWidth: 300,
      padding: 20,
      viewportHeight: 500,
      viewportWidth: 700,
    });

    expect(fitted.scale).toBeCloseTo(2.2);
    expect(fitted.translateX).toBeCloseTo(20);
    expect(fitted.translateY).toBeCloseTo(30);
  });

  it("centers visible bounds when svg content has a coordinate offset", () => {
    const fitted = fitDiagramToViewport({
      diagramHeight: 200,
      diagramWidth: 300,
      diagramX: 1000,
      diagramY: 400,
      padding: 20,
      viewportHeight: 500,
      viewportWidth: 700,
    });

    expect(fitted.scale).toBeCloseTo(2.2);
    expect(fitted.translateX).toBeCloseTo(-2180);
    expect(fitted.translateY).toBeCloseTo(-850);
  });
});
