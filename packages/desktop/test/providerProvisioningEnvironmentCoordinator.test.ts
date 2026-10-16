import { describe, expect, it, vi } from "vitest";
import { ProviderProvisioningEnvironmentCoordinator } from "../src/main/providerProvisioningEnvironmentCoordinator.js";

describe("Provider Provisioning Environment Coordinator", () => {
  it("coalesces multiple registrations of one Environment into one initial sync", async () => {
    const executeA = vi.fn(async () => undefined);
    const executeB = vi.fn(async () => undefined);
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();

    const first = coordinator.register("ssh:one", "host-a", executeA);
    const second = coordinator.register("ssh:one", "host-b", executeB);
    await first.initialSync;
    await second.initialSync;

    expect(executeA.mock.calls.length + executeB.mock.calls.length).toBe(1);
  });

  it("syncs different Environments independently", async () => {
    const executeA = vi.fn(async () => undefined);
    const executeB = vi.fn(async () => undefined);
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();

    await Promise.all([
      coordinator.register("ssh:one", "host-a", executeA).initialSync,
      coordinator.register("docker:two", "host-b", executeB).initialSync,
    ]);

    expect(executeA).toHaveBeenCalledOnce();
    expect(executeB).toHaveBeenCalledOnce();
  });

  it("runs one trailing refresh with the latest generation", async () => {
    let finishFirst: (() => void) | undefined;
    const execute = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined);
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();
    const registration = coordinator.register("ssh:one", "host-a", execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const saveA = coordinator.requestAll("personal-config");
    const saveB = coordinator.requestAll("credential");
    finishFirst?.();
    await Promise.all([registration.initialSync, saveA, saveB]);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("keeps one pending intent while offline and drains it when the Environment returns", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();
    const first = coordinator.register(
      "ssh:one",
      "host-a",
      vi.fn(async () => undefined),
    );
    await first.initialSync;
    first.dispose();

    void coordinator.requestAll("personal-config");
    const execute = vi.fn(async () => undefined);
    const second = coordinator.register("ssh:one", "host-b", execute);
    await second.initialSync;

    expect(execute).toHaveBeenCalledOnce();
  });

  it("hands an interrupted generation to another online Host", async () => {
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = coordinator.register(
      "ssh:one",
      "host-a",
      () => new Promise<void>((_resolve, reject) => (rejectFirst = reject)),
    );
    const executeB = vi.fn(async () => undefined);
    const second = coordinator.register("ssh:one", "host-b", executeB);
    await vi.waitFor(() => expect(rejectFirst).toBeDefined());

    first.dispose();
    rejectFirst?.(new Error("host exited"));
    await second.initialSync;

    expect(executeB).toHaveBeenCalledOnce();
  });

  it("does not spin on an ordinary failure and retries on the next real trigger", async () => {
    const execute = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("remote unavailable"))
      .mockResolvedValue(undefined);
    const coordinator = new ProviderProvisioningEnvironmentCoordinator();

    const registration = coordinator.register("ssh:one", "host-a", execute);
    await expect(registration.initialSync).rejects.toThrow("remote unavailable");
    expect(execute).toHaveBeenCalledOnce();

    await coordinator.requestAll("personal-config");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
