import type { RemoteTarget } from "@zcode/shared";

export function formatRemoteLinkRailTarget(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return `WSL · ${target.distro ?? "default"}`;
    case "docker":
      return `Docker · ${target.container}`;
    case "server":
      return target.url;
  }
}

export function formatRemoteLinkRailDevice(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return target.host;
    case "wsl":
      return target.distro ?? "WSL";
    case "docker":
      return target.container;
    case "server":
      return target.name ?? target.url;
  }
}
