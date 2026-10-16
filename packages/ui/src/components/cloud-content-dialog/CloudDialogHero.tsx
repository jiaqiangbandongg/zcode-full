import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudImage,
  CloudVideo,
  CloudLottie,
} from "@/components/cloud-content-dialog/CloudDialogMediaHero.js";
import type {
  CloudDialogHero as CloudDialogHeroDefinition,
  CloudHeroHostMessage,
  CloudHeroResourceMessage,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";

export const CLOUD_HERO_MESSAGE_CHANNEL = "zcode-cloud-hero-v1" as const;

let nextCloudHeroInstanceId = 0;

type CloudHeroMessageEvent = Pick<MessageEvent, "data" | "source">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCloudHeroResourceMessage(value: unknown): value is CloudHeroResourceMessage {
  if (!isRecord(value)) return false;
  if (value.channel !== CLOUD_HERO_MESSAGE_CHANNEL || typeof value.instanceId !== "string") {
    return false;
  }
  switch (value.type) {
    case "ready":
      return true;
    case "action":
      return typeof value.id === "string";
    case "resize":
      return typeof value.height === "number" && Number.isFinite(value.height);
    case "error":
      return typeof value.code === "string";
    default:
      return false;
  }
}

export function isTrustedCloudHeroMessage(
  event: CloudHeroMessageEvent,
  frameWindow: Window | null,
  instanceId: string,
): event is CloudHeroMessageEvent & { data: CloudHeroResourceMessage } {
  return (
    frameWindow !== null &&
    event.source === frameWindow &&
    isCloudHeroResourceMessage(event.data) &&
    event.data.instanceId === instanceId
  );
}

function resolveDocumentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function resolveReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function CloudInteractiveBundleHero({
  hero,
  locale,
  title,
  onAction,
  presentation = false,
  hovered = false,
  onReadyChange,
}: {
  hero: Extract<CloudDialogHeroDefinition, { type: "interactive_bundle" }>;
  locale: string;
  title: string;
  onAction?: (actionId: string) => void;
  presentation?: boolean;
  hovered?: boolean;
  onReadyChange?: (ready: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => {
    nextCloudHeroInstanceId += 1;
    return `cloud-hero-${nextCloudHeroInstanceId}`;
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const readyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    onReadyChange?.(status === "ready" || (status === "error" && Boolean(hero.fallback)));
  }, [status, hero.fallback, onReadyChange]);

  useEffect(() => {
    readyTimer.current = setTimeout(() => setStatus("error"), 5_000);
    return () => clearTimeout(readyTimer.current);
  }, []);

  const postToHero = useCallback((message: CloudHeroHostMessage) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  useEffect(() => {
    if (!presentation || status !== "ready") return;
    // Banner 的 iframe 必须隔离点击，因此只桥接视觉 hover，不放开原生指针或 action。
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncHover = () =>
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "hover",
        instanceId,
        hovered: hovered && !media?.matches,
      });
    syncHover();
    media?.addEventListener("change", syncHover);
    return () => media?.removeEventListener("change", syncHover);
  }, [hovered, instanceId, postToHero, presentation, status]);

  const sendInit = useCallback(() => {
    postToHero({
      channel: CLOUD_HERO_MESSAGE_CHANNEL,
      type: "init",
      instanceId,
      theme: resolveDocumentTheme(),
      locale,
      reducedMotion: resolveReducedMotion(),
      data: hero.data,
    });
  }, [hero.data, instanceId, locale, postToHero]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!isTrustedCloudHeroMessage(event, frameRef.current?.contentWindow ?? null, instanceId)) {
        return;
      }
      switch (event.data.type) {
        case "ready":
          clearTimeout(readyTimer.current);
          setStatus("ready");
          return;
        case "action":
          if (!presentation && Object.hasOwn(hero.events, event.data.id))
            onAction?.(hero.events[event.data.id]!);
          return;
        case "error":
          clearTimeout(readyTimer.current);
          setStatus("error");
          return;
        case "resize":
          return;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [hero.events, instanceId, onAction, presentation]);

  useEffect(() => {
    const handleVisibility = () => {
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "visibility",
        instanceId,
        visible: document.visibilityState !== "hidden",
      });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [instanceId, postToHero]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      postToHero({
        channel: CLOUD_HERO_MESSAGE_CHANNEL,
        type: "theme",
        instanceId,
        theme: resolveDocumentTheme(),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [instanceId, postToHero]);

  useEffect(() => {
    const frame = frameRef.current;
    return () => {
      frame?.contentWindow?.postMessage(
        {
          channel: CLOUD_HERO_MESSAGE_CHANNEL,
          type: "destroy",
          instanceId,
        } satisfies CloudHeroHostMessage,
        "*",
      );
    };
  }, [instanceId]);

  if (status === "error")
    return hero.fallback ? (
      presentation ? (
        <img src={hero.fallback.src} alt="" className="size-full object-contain" />
      ) : (
        <CloudImage hero={hero.fallback} />
      )
    ) : (
      <div data-testid="cloud-dialog-hero-error" className="size-full bg-surface" />
    );
  return (
    <iframe
      ref={frameRef}
      src={hero.resolvedUrl}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      data-testid="cloud-dialog-interactive-hero"
      data-hero-type={hero.type}
      data-instance-id={instanceId}
      data-status={status}
      onLoad={sendInit}
      onError={() => setStatus("error")}
      tabIndex={presentation ? -1 : undefined}
      aria-hidden={presentation || undefined}
      className={
        presentation
          ? "pointer-events-none size-full border-0 bg-transparent"
          : "size-full border-0 bg-surface"
      }
    />
  );
}

export function CloudDialogHero({
  hero,
  locale,
  title,
  onAction,
}: {
  hero: CloudDialogHeroDefinition;
  locale: string;
  title: string;
  onAction?: (actionId: string) => void;
}) {
  if (hero.type === "image") return <CloudImage hero={hero} />;
  if (hero.type === "video") return <CloudVideo hero={hero} title={title} />;
  if (hero.type === "lottie") return <CloudLottie hero={hero} title={title} />;
  if (hero.type !== "interactive_bundle") return null;
  if (!hero.resolvedUrl)
    return hero.fallback ? (
      <CloudImage hero={hero.fallback} />
    ) : (
      <div data-testid="cloud-dialog-hero-unresolved" className="size-full bg-surface" />
    );
  return (
    <CloudInteractiveBundleHero
      key={hero.resolvedUrl}
      hero={hero}
      locale={locale}
      title={title}
      onAction={onAction}
    />
  );
}
