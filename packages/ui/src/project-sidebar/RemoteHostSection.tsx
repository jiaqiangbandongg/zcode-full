import type { RemoteProjectHost } from "@/project-sidebar/contract.js";

export function remoteHostLabel(host: RemoteProjectHost): string {
  const target = host.target;
  if (!target) return host.id;
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}`;
    case "docker":
      return target.container;
    case "wsl":
      return target.distro || "WSL";
    case "server":
      return target.name || target.url;
  }
}
