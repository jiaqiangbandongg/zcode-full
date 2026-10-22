// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  RemoteConnectionProgressProvider,
  usePublishRemoteConnectionProgress,
  useRemoteConnectionProgress,
} from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";

afterEach(cleanup);
it("publishing a background projection updates readers without rendering its owner again", async () => {
  const renders = vi.fn();
  function Owner() {
    renders();
    if (renders.mock.calls.length > 12)
      throw new Error("Publishing rendered the connection owner repeatedly");
    const [name, setName] = useState("First device");
    usePublishRemoteConnectionProgress({
      operationId: "one",
      view: "connecting",
      cancelled: false,
      target: null,
      name,
      logs: [],
      error: "",
      reason: "",
      waiting: false,
      ready: true,
      onResume() {},
      onCancel() {},
    });
    return createElement("button", { onClick: () => setName("Renamed device") }, "rename");
  }
  function Reader() {
    return createElement("span", null, useRemoteConnectionProgress()?.name);
  }
  render(
    createElement(
      RemoteConnectionProgressProvider,
      null,
      createElement(Owner),
      createElement(Reader),
    ),
  );
  expect(await screen.findByText("First device")).toBeTruthy();
  expect(renders).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "rename" }));
  expect(await screen.findByText("Renamed device")).toBeTruthy();
  expect(renders).toHaveBeenCalledTimes(2);
});
