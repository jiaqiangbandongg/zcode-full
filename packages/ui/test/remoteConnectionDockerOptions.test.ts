import { describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo, IPlatformService } from "@zcode/shared";
import {
  loadRemoteConnectionDockerOptions,
  resolveDockerContainerSelectionAfterRefresh,
} from "@/lib/remoteConnectionDockerOptions.js";

type DockerPlatform = Pick<
  IPlatformService,
  "isDockerAvailable" | "listDockerContainers"
>;

const containers: DockerContainerInfo[] = [
  {
    id: "abc123",
    image: "ubuntu:latest",
    name: "zcode-dev",
    state: "running",
    status: "Up 2 minutes",
  },
];

describe("loadRemoteConnectionDockerOptions", () => {
  it("loads running containers when Docker is available", async () => {
    const platform: DockerPlatform = {
      isDockerAvailable: vi.fn(async () => true),
      listDockerContainers: vi.fn(async () => containers),
    };

    await expect(loadRemoteConnectionDockerOptions(platform)).resolves.toEqual({
      dockerAvailable: true,
      dockerContainers: containers,
      error: "",
    });
    expect(platform.listDockerContainers).toHaveBeenCalledTimes(1);
  });

  it("skips container listing when Docker is unavailable", async () => {
    const platform: DockerPlatform = {
      isDockerAvailable: vi.fn(async () => false),
      listDockerContainers: vi.fn(async () => containers),
    };

    await expect(loadRemoteConnectionDockerOptions(platform)).resolves.toEqual({
      dockerAvailable: false,
      dockerContainers: [],
      error: "",
    });
    expect(platform.listDockerContainers).not.toHaveBeenCalled();
  });

  it("returns an error state when Docker detection fails", async () => {
    const platform: DockerPlatform = {
      isDockerAvailable: vi.fn(async () => {
        throw new Error("docker daemon unavailable");
      }),
      listDockerContainers: vi.fn(async () => containers),
    };

    await expect(loadRemoteConnectionDockerOptions(platform)).resolves.toEqual({
      dockerAvailable: null,
      dockerContainers: [],
      error: "Error: docker daemon unavailable",
    });
    expect(platform.listDockerContainers).not.toHaveBeenCalled();
  });
});

describe("resolveDockerContainerSelectionAfterRefresh", () => {
  it("clears the selected container when the refreshed running container list no longer contains it", () => {
    expect(
      resolveDockerContainerSelectionAfterRefresh({
        currentContainer: "zcode-dev",
        dockerContainers: [],
      }),
    ).toBe("");
  });

  it("keeps the selected container when the refreshed running container list still contains its name", () => {
    expect(
      resolveDockerContainerSelectionAfterRefresh({
        currentContainer: "zcode-dev",
        dockerContainers: containers,
      }),
    ).toBe("zcode-dev");
  });

  it("keeps the selected container when the refreshed running container list contains its id", () => {
    expect(
      resolveDockerContainerSelectionAfterRefresh({
        currentContainer: "abc123",
        dockerContainers: containers,
      }),
    ).toBe("abc123");
  });
});
