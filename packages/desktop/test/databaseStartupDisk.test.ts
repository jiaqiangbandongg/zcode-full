import { expect, it } from "vitest";
import { StartupDiskSampler } from "../src/host/startupDiskSampler.js";

it("retains observed peak after rollback, shares scopes, and never overlaps probes", async () => {
  let available = 1000;
  let calls = 0;
  let inFlight = 0;
  const sampler = new StartupDiskSampler({
    probe: async () => {
      calls++;
      inFlight++;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      inFlight--;
      return { scope: "volume-1", availableBytes: available };
    },
  });
  await sampler.addPath("/data/tasks.sqlite");
  await sampler.addPath("/data/session.sqlite");
  available = 200;
  await Promise.all([sampler.sample(), sampler.sample()]);
  available = 900;
  await sampler.sample();
  expect(sampler.snapshot()).toEqual([
    expect.objectContaining({ observedAvailableDropPeakBytes: 800, quality: "complete" }),
  ]);
  expect(calls).toBe(4);
  sampler.stop();
});

it("uses unknown for a failed baseline and never waits for a final probe", async () => {
  const sampler = new StartupDiskSampler({
    probe: async () => {
      throw new Error("IO");
    },
  });
  await sampler.addPath("/broken/db.sqlite");
  expect(sampler.snapshot()[0]?.observedAvailableDropPeakBytes).toBeNull();
  expect(sampler.snapshot()[0]?.quality).toBe("unknown");
  sampler.stop();
});
