import { beforeEach, describe, expect, it, vi } from "vitest";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

describe("task notification preferences", () => {
  beforeEach(() => {
    localStorageState.clear();
    vi.resetModules();
  });

  it("treats notification sound as disabled when task notifications are off", async () => {
    localStorageState.set("zcode-notification-enabled", "false");
    localStorageState.set("zcode-notification-sound-enabled", "true");

    const { isTaskNotificationSoundEnabled } = await import(
      "../src/lib/taskNotificationPreferences.js"
    );

    expect(isTaskNotificationSoundEnabled()).toBe(false);
  });

  it("skips audio playback when the notification sound preference is disabled", async () => {
    const audioInstance = {
      pause: vi.fn(),
      currentTime: 7,
      play: vi.fn(() => Promise.resolve()),
      preload: "",
    };
    const audioConstructor = vi.fn(function AudioMock() {
      return audioInstance;
    });

    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: audioConstructor,
    });

    localStorageState.set("zcode-notification-enabled", "true");
    localStorageState.set("zcode-notification-sound-enabled", "false");

    const { playTaskNotificationSound } = await import(
      "../src/lib/taskNotificationSound.js"
    );

    await playTaskNotificationSound();

    expect(audioConstructor).not.toHaveBeenCalled();
  });

  it("plays the sound only when notifications and notification sound are both enabled", async () => {
    const pause = vi.fn();
    const play = vi.fn(() => Promise.resolve());
    const audio = {
      pause,
      currentTime: 12,
      play,
      preload: "",
    };

    const audioConstructor = vi.fn(function AudioMock() {
      return audio;
    });

    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: audioConstructor,
    });

    localStorageState.set("zcode-notification-enabled", "true");
    localStorageState.set("zcode-notification-sound-enabled", "true");

    const { playTaskNotificationSound } = await import(
      "../src/lib/taskNotificationSound.js"
    );

    await playTaskNotificationSound();

    expect(audioConstructor).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
  });
});
