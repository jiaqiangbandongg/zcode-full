import { useSyncExternalStore } from "react";

function snapshot() {
  return `${document.documentElement.classList.contains("dark")}:${window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false}:${document.visibilityState !== "hidden"}`;
}
function subscribe(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  motion?.addEventListener("change", notify);
  document.addEventListener("visibilitychange", notify);
  return () => {
    observer.disconnect();
    motion?.removeEventListener("change", notify);
    document.removeEventListener("visibilitychange", notify);
  };
}
export function useCloudHeroEnvironment() {
  const state = useSyncExternalStore(subscribe, snapshot, () => "false:false:true");
  const [dark = false, reduced = false, visible = true] = state
    .split(":")
    .map((value) => value === "true");
  return { dark, reduced, visible, animate: visible && !reduced };
}
