import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web";
import type {
  CloudImageHero,
  CloudVideoHero,
  CloudLottieHero,
} from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { useCloudHeroEnvironment } from "@/components/cloud-content-dialog/useCloudHeroEnvironment.js";
import { loadCloudLottieData } from "@/components/cloud-content-dialog/cloudLottieRuntime.js";

export function CloudImage({ hero }: { hero: CloudImageHero }) {
  const { dark } = useCloudHeroEnvironment();
  const src = dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return <ImageResource key={src} hero={hero} src={src} />;
}
function ImageResource({ hero, src }: { hero: CloudImageHero; src: string }) {
  const [status, setStatus] = useState("loading");
  return (
    <div
      className="size-full bg-surface"
      data-testid="cloud-dialog-image-hero"
      data-status={status}
    >
      {status === "error" ? (
        <div role="img" aria-label={hero.alt} className="size-full" />
      ) : (
        <img
          src={src}
          alt={hero.alt}
          referrerPolicy="no-referrer"
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          className={`size-full ${hero.fit === "contain" ? "object-contain" : "object-cover"}`}
        />
      )}
    </div>
  );
}

export function CloudVideo({
  hero,
  title,
  presentation = false,
}: {
  hero: CloudVideoHero;
  title: string;
  presentation?: boolean;
}) {
  const environment = useCloudHeroEnvironment();
  const src = environment.dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return (
    <VideoResource
      key={src}
      hero={hero}
      src={src}
      title={title}
      animate={environment.animate}
      presentation={presentation}
    />
  );
}
function VideoResource({
  hero,
  src,
  title,
  animate,
  presentation,
}: {
  hero: CloudVideoHero;
  src: string;
  title: string;
  animate: boolean;
  presentation: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (animate && hero.autoplay) void video.play().catch(() => {});
    else video.pause();
    return () => video.pause();
  }, [animate, hero.autoplay]);
  if (failed)
    return <CloudImage hero={{ type: "image", src: hero.poster, alt: title, fit: hero.fit }} />;
  return (
    <video
      ref={ref}
      src={src}
      poster={hero.poster}
      muted
      playsInline
      controls={!presentation}
      tabIndex={presentation ? -1 : undefined}
      loop={hero.loop}
      autoPlay={Boolean(hero.autoplay && animate)}
      preload="metadata"
      aria-label={title}
      data-testid="cloud-dialog-video-hero"
      onError={() => setFailed(true)}
      className={`size-full ${hero.fit === "contain" ? "object-contain" : "object-cover"}`}
    />
  );
}

export function CloudLottie({ hero, title }: { hero: CloudLottieHero; title: string }) {
  const environment = useCloudHeroEnvironment();
  const src = environment.dark && hero.darkSrc ? hero.darkSrc : hero.src;
  return (
    <LottieResource
      key={`${src}:${hero.loop}:${hero.speed}`}
      hero={hero}
      src={src}
      title={title}
      animate={environment.animate}
    />
  );
}
function LottieResource({
  hero,
  src,
  title,
  animate,
}: {
  hero: CloudLottieHero;
  src: string;
  title: string;
  animate: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const animation = useRef<AnimationItem | null>(null);
  const playback = useRef({ animate, autoplay: hero.autoplay });
  playback.current = { animate, autoplay: hero.autoplay };
  const [status, setStatus] = useState("loading");
  useEffect(() => {
    const controller = new AbortController();
    let item: AnimationItem | undefined;
    const destroy = () => {
      item?.destroy();
      item = undefined;
      animation.current = null;
    };
    const timer = window.setTimeout(() => {
      controller.abort();
      destroy();
      setStatus("error");
    }, 10_000);
    void Promise.all([
      import("lottie-web/build/player/lottie_light_canvas.js"),
      loadCloudLottieData(src, controller.signal),
    ])
      .then(([module, data]) => {
        if (controller.signal.aborted || !container.current) return;
        item = module.default.loadAnimation({
          container: container.current,
          renderer: "canvas",
          autoplay: false,
          loop: hero.loop ?? false,
          animationData: data,
        });
        animation.current = item;
        item.setSpeed(Math.max(0.1, Math.min(4, hero.speed ?? 1)));
        const ready = () => {
          window.clearTimeout(timer);
          if (!controller.signal.aborted) setStatus("ready");
        };
        const fail = () => {
          window.clearTimeout(timer);
          destroy();
          if (!controller.signal.aborted) setStatus("error");
        };
        item.addEventListener("DOMLoaded", ready);
        item.addEventListener("data_failed", fail);
        item.addEventListener("error", fail);
        if (item.isLoaded) ready();
        if (playback.current.animate && playback.current.autoplay) item.play();
        else item.goToAndStop(0, true);
      })
      .catch(() => {
        destroy();
        if (!controller.signal.aborted) setStatus("error");
        window.clearTimeout(timer);
      });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      destroy();
    };
  }, [src, hero.loop, hero.speed]);
  useEffect(() => {
    if (animate && hero.autoplay) animation.current?.play();
    else animation.current?.pause();
  }, [animate, hero.autoplay]);
  if (status === "error" && hero.fallback) return <CloudImage hero={hero.fallback} />;
  return (
    <div
      ref={container}
      className="size-full"
      role="img"
      aria-label={title}
      data-testid="cloud-dialog-lottie-hero"
      data-status={status}
    />
  );
}
