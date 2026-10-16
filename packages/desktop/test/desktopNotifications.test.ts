import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const electronMocks = vi.hoisted(() => {
  const notificationInstances: NotificationMock[] = [];

  class NotificationMock {
    static isSupported = vi.fn(() => true);

    handlers = new Map<string, Array<() => void>>();
    once = vi.fn((event: string, handler: () => void) => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    });
    show = vi.fn();

    constructor(public options: unknown) {
      notificationInstances.push(this);
    }

    emit(event: string) {
      const handlers = this.handlers.get(event) ?? [];
      this.handlers.delete(event);
      for (const handler of handlers) {
        handler();
      }
    }
  }

  return {
    appDockShow: vi.fn(),
    appFocus: vi.fn(),
    appShow: vi.fn(),
    browserWindowFromWebContents: vi.fn(),
    browserWindowGetAllWindows: vi.fn(() => []),
    NotificationMock,
    notificationInstances,
  };
});

vi.mock("electron", () => ({
  app: {
    dock: {
      show: electronMocks.appDockShow,
    },
    focus: electronMocks.appFocus,
    show: electronMocks.appShow,
  },
  BrowserWindow: {
    fromWebContents: electronMocks.browserWindowFromWebContents,
    getAllWindows: electronMocks.browserWindowGetAllWindows,
  },
  Notification: electronMocks.NotificationMock,
}));

import {
  dispatchTaskNotification,
  getActiveTaskNotificationCountForTest,
  resetActiveTaskNotificationsForTest,
} from "../src/main/desktopNotifications.js";

function createTaskNotificationPayload(taskId = "task-1") {
  return {
    taskId,
    status: "completed" as const,
    title: "测试任务完成",
    body: "可以回来看结果了",
  };
}

describe("desktop task notifications", () => {
  beforeEach(() => {
    electronMocks.NotificationMock.isSupported.mockReturnValue(true);
    electronMocks.notificationInstances.length = 0;
    electronMocks.appDockShow.mockClear();
    electronMocks.appFocus.mockClear();
    electronMocks.appShow.mockClear();
    electronMocks.browserWindowFromWebContents.mockReset();
    electronMocks.browserWindowGetAllWindows.mockReset();
    electronMocks.browserWindowGetAllWindows.mockReturnValue([]);
    resetActiveTaskNotificationsForTest();
  });

  it("does not generate fallback copy in main process when localized notification copy is missing", () => {
    const eventSender = {
      send: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const shown = dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: {
        ...createTaskNotificationPayload("task-missing-copy"),
        title: " ",
        body: "",
      },
      logger,
    });

    expect(shown).toBe(false);
    expect(electronMocks.notificationInstances).toHaveLength(0);
    expect(eventSender.send).not.toHaveBeenCalledWith(PlatformChannels.TaskNotificationSound);
    expect(logger.warn).toHaveBeenCalledWith(
      "[show-task-notification] missing localized notification copy",
      {
        taskId: "task-missing-copy",
        status: "completed",
        hasTitle: false,
        hasBody: false,
      },
    );
  });

  it("keeps native notifications alive until the click handler can focus the task window", () => {
    const eventSender = {
      send: vi.fn(),
    };
    const senderWindow = {
      id: 7,
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        send: vi.fn(),
      },
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    electronMocks.browserWindowFromWebContents.mockReturnValue(senderWindow);

    const shown = dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: createTaskNotificationPayload(),
      logger,
    });

    expect(shown).toBe(true);
    expect(getActiveTaskNotificationCountForTest()).toBe(1);
    expect(eventSender.send).toHaveBeenCalledWith(PlatformChannels.TaskNotificationSound);

    electronMocks.notificationInstances[0]?.emit("click");

    expect(getActiveTaskNotificationCountForTest()).toBe(0);
    expect(senderWindow.restore).toHaveBeenCalledTimes(1);
    expect(senderWindow.show).toHaveBeenCalledTimes(1);
    expect(senderWindow.focus).toHaveBeenCalledTimes(1);
    expect(senderWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.TaskNotificationClick,
      "task-1",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[show-task-notification] notification click handled",
      { taskId: "task-1", windowId: 7 },
    );
    expect(senderWindow.restore.mock.invocationCallOrder[0]).toBeLessThan(
      senderWindow.focus.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );

    if (process.platform === "darwin") {
      expect(electronMocks.appDockShow).toHaveBeenCalledTimes(1);
      expect(electronMocks.appShow).toHaveBeenCalledTimes(1);
      expect(electronMocks.appFocus).toHaveBeenCalledWith({ steal: true });
      expect(senderWindow.show.mock.invocationCallOrder[0]).toBeLessThan(
        electronMocks.appFocus.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
    }
  });

  it("releases retained notifications when the OS closes them", () => {
    const eventSender = {
      send: vi.fn(),
    };
    electronMocks.browserWindowFromWebContents.mockReturnValue({
      webContents: {
        send: vi.fn(),
      },
    });

    dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: createTaskNotificationPayload("task-closed-by-os"),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(getActiveTaskNotificationCountForTest()).toBe(1);

    electronMocks.notificationInstances[0]?.emit("close");

    expect(getActiveTaskNotificationCountForTest()).toBe(0);
  });

  it("deduplicates elicitation notifications by request id instead of task id", () => {
    const eventSender = {
      send: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const firstShown = dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: {
        taskId: "task-awaiting-user",
        status: "elicitation_request",
        requestId: "question-1",
        title: "需要你确认",
        body: "请回答当前问题",
      },
      logger,
    });
    const duplicateShown = dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: {
        taskId: "task-awaiting-user",
        status: "elicitation_request",
        requestId: "question-1",
        title: "需要你确认",
        body: "请回答当前问题",
      },
      logger,
    });
    const nextRequestShown = dispatchTaskNotification({
      event: { sender: eventSender } as never,
      payload: {
        taskId: "task-awaiting-user",
        status: "elicitation_request",
        requestId: "question-2",
        title: "需要你确认",
        body: "请回答下一个问题",
      },
      logger,
    });

    expect(firstShown).toBe(true);
    expect(duplicateShown).toBe(false);
    expect(nextRequestShown).toBe(true);
    expect(electronMocks.notificationInstances).toHaveLength(2);
    expect(eventSender.send).toHaveBeenCalledTimes(2);
    expect(eventSender.send).toHaveBeenCalledWith(PlatformChannels.TaskNotificationSound);
  });
});
