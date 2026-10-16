import assert from "node:assert/strict";
import test from "node:test";

import {
  countStableSelectorRequests,
  verifyHeadlessRequestBoundary,
  verifyStableExtractionRequestCount,
} from "./memory-e2e-evidence.mjs";

test("headless Extraction evidence allows an asynchronous Selector request", () => {
  const mainRequest = request("main", 1);
  const result = verifyHeadlessRequestBoundary([request("selector", 0), mainRequest]);

  assert.equal(result.mainRequest, mainRequest);
  assert.equal(result.selectorRequestCount, 1);
});

test("headless Extraction evidence rejects an Extraction request", () => {
  assert.throws(
    () => verifyHeadlessRequestBoundary([request("main", 0), request("extraction", 1)]),
    /headless Memory must not issue Extraction requests/u,
  );
});

test("the exact Selector trajectory excludes an optional headless Selector", () => {
  const records = [
    request("selector", 0),
    { category: "selector", index: 1, scenario: "project" },
    { category: "selector", index: 2, scenario: "project" },
  ];

  assert.equal(countStableSelectorRequests(records), 2);
});

test("Extraction evidence allows the scheduler to coalesce the initial no-op snapshot", () => {
  assert.doesNotThrow(() => verifyStableExtractionRequestCount(5));
  assert.doesNotThrow(() => verifyStableExtractionRequestCount(6));
  assert.throws(() => verifyStableExtractionRequestCount(4), /five or six Extraction requests/u);
  assert.throws(() => verifyStableExtractionRequestCount(7), /five or six Extraction requests/u);
});

function request(category, index) {
  return { category, index, scenario: "headless" };
}
