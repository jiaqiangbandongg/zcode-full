import { describe, expect, it } from "vitest";
import {
  buildPresentationPageElements,
  hitTestPresentationElement,
} from "@/presentation/presentationElementModel.js";

describe("presentation element model", () => {
  it("只暴露 slide-owned 元素，并把组内文本作为 shape 引用", () => {
    const elements = buildPresentationPageElements({
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodes: [
        {
          id: "2",
          name: "Title",
          nodeType: "shape",
          position: { x: 10, y: 20 },
          size: { w: 300, h: 60 },
          text: "Quarterly review",
        },
        {
          id: "3",
          name: "Photo",
          nodeType: "picture",
          position: { x: 20, y: 100 },
          size: { w: 200, h: 100 },
        },
        {
          id: "4",
          name: "Group 1",
          nodeType: "group",
          position: { x: 0, y: 0 },
          size: { w: 400, h: 300 },
        },
      ],
      groupTextEntries: [
        {
          nodeId: "9",
          nodePath: "slides/0/nodes/4/children/0/9",
          text: "Grouped label",
          bounds: { x: 40, y: 50, w: 120, h: 30 },
        },
      ],
    });

    expect(
      elements.map((element) => [element.nodeType, element.nodeId]),
    ).toEqual([
      ["shape", "2"],
      ["picture", "3"],
      ["shape", "9"],
    ]);
    expect(elements[2]).toMatchObject({
      nodePath: "slides/0/nodes/4/children/0/9",
      text: "Grouped label",
      zIndex: 2,
    });
  });

  it("为 table cell 生成稳定坐标和按合并跨度计算的 bounds", () => {
    const elements = buildPresentationPageElements({
      slideIndex: 1,
      slidePart: "ppt/slides/slide2.xml",
      nodes: [
        {
          id: "7",
          name: "Metrics",
          nodeType: "table",
          position: { x: 100, y: 50 },
          size: { w: 300, h: 200 },
          columns: [1, 2],
          rows: [
            {
              height: 1,
              cells: [
                {
                  gridSpan: 2,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: false,
                  text: "Header",
                },
                {
                  gridSpan: 1,
                  rowSpan: 1,
                  hMerge: true,
                  vMerge: false,
                  text: "",
                },
              ],
            },
            {
              height: 3,
              cells: [
                {
                  gridSpan: 1,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: false,
                  text: "A",
                },
                {
                  gridSpan: 1,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: false,
                  text: "42",
                },
              ],
            },
          ],
        },
      ],
      groupTextEntries: [],
    });

    const header = elements.find(
      (element) => element.nodeType === "table-cell" && element.rowIndex === 0,
    );
    const value = elements.find(
      (element) =>
        element.nodeType === "table-cell" &&
        element.rowIndex === 1 &&
        element.cellIndex === 1,
    );
    expect(header?.bounds).toEqual({ x: 100, y: 50, width: 300, height: 50 });
    expect(value?.bounds).toEqual({ x: 200, y: 100, width: 200, height: 150 });
  });

  it("纵向合并续行按 gridSpan 推进列游标，不把后续 cell overlay 左移", () => {
    const elements = buildPresentationPageElements({
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodes: [
        {
          id: "7",
          name: "Merged metrics",
          nodeType: "table",
          position: { x: 0, y: 0 },
          size: { w: 300, h: 100 },
          columns: [1, 1, 1],
          rows: [
            {
              height: 1,
              cells: [
                {
                  gridSpan: 2,
                  rowSpan: 2,
                  hMerge: false,
                  vMerge: false,
                  text: "Merged",
                },
                {
                  gridSpan: 1,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: false,
                  text: "Top right",
                },
              ],
            },
            {
              height: 1,
              cells: [
                {
                  gridSpan: 2,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: true,
                  text: "",
                },
                {
                  gridSpan: 1,
                  rowSpan: 1,
                  hMerge: false,
                  vMerge: false,
                  text: "Bottom right",
                },
              ],
            },
          ],
        },
      ],
      groupTextEntries: [],
    });

    const bottomRight = elements.find(
      (element) =>
        element.nodeType === "table-cell" &&
        element.rowIndex === 1 &&
        element.cellIndex === 1,
    );
    expect(bottomRight?.bounds).toEqual({
      x: 200,
      y: 50,
      width: 100,
      height: 50,
    });
  });

  it("命中时优先 table cell，再按 z-order 选择最上层元素", () => {
    const elements = buildPresentationPageElements({
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodes: [
        {
          id: "2",
          name: "Back",
          nodeType: "shape",
          position: { x: 0, y: 0 },
          size: { w: 100, h: 100 },
          text: "Back",
        },
        {
          id: "3",
          name: "Front",
          nodeType: "shape",
          position: { x: 20, y: 20 },
          size: { w: 100, h: 100 },
          text: "Front",
        },
      ],
      groupTextEntries: [],
    });

    expect(hitTestPresentationElement(elements, { x: 30, y: 30 })?.nodeId).toBe(
      "3",
    );
  });
});
