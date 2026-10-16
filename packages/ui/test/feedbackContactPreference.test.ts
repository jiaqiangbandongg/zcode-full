import { describe, expect, it, vi } from "vitest";

import {
  clearFeedbackContactPreference,
  persistFeedbackContactPreference,
  readFeedbackContactPreference,
  rememberFeedbackContactInput,
} from "@/feedback/feedbackContactPreference.js";

function createMemoryStorage(initial?: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe("feedback contact preference", () => {
  it("reads the saved contact from local storage", () => {
    const storage = createMemoryStorage({
      "zcode.feedback.contact": "user@example.com",
    });

    expect(readFeedbackContactPreference(storage)).toBe("user@example.com");
  });

  it("persists the trimmed submitted contact", () => {
    const storage = createMemoryStorage();

    persistFeedbackContactPreference("  user@example.com  ", storage);

    expect(storage.setItem).toHaveBeenCalledWith(
      "zcode.feedback.contact",
      "user@example.com",
    );
    expect(readFeedbackContactPreference(storage)).toBe("user@example.com");
  });

  it("remembers contact as soon as the user types", () => {
    const storage = createMemoryStorage();

    const nextValue = rememberFeedbackContactInput("  user@example.com  ", storage);

    expect(nextValue).toBe("  user@example.com  ");
    expect(storage.setItem).toHaveBeenCalledWith(
      "zcode.feedback.contact",
      "user@example.com",
    );
    expect(readFeedbackContactPreference(storage)).toBe("user@example.com");
  });

  it("clears the saved contact when the submitted value is empty", () => {
    const storage = createMemoryStorage({
      "zcode.feedback.contact": "user@example.com",
    });

    persistFeedbackContactPreference("   ", storage);

    expect(storage.removeItem).toHaveBeenCalledWith("zcode.feedback.contact");
    expect(readFeedbackContactPreference(storage)).toBe("");
  });

  it("does not throw when local storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("storage blocked");
      }),
    } as unknown as Storage;

    expect(readFeedbackContactPreference(storage)).toBe("");
    expect(() => persistFeedbackContactPreference("user@example.com", storage)).not.toThrow();
    expect(() => clearFeedbackContactPreference(storage)).not.toThrow();
  });
});
