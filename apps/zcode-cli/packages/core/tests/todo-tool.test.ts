import { describe, expect, it } from "vitest";
import {
  createSessionId,
  formatTodoStateForModel,
  todoItemsFromToolResultContent,
  type SessionStorePort,
  type TodoItem,
} from "@zcode/contracts";
import { todoReadHandler, todoWriteHandler } from "../src/tool/handlers/todo.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

describe("todo tools", () => {
  it("writes and reads session-local todos through the session store port", async () => {
    const store = createTodoStore();
    const context = createContext(store);

    const write = await todoWriteHandler(
      {
        todos: [
          {
            content: "Review v2 spec",
            priority: "high",
            status: "completed",
          },
          {
            content: "Implement TodoWrite",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
      context,
    );
    const read = await todoReadHandler({}, context);

    expect(write).toEqual({
      oldTodos: [],
      todos: [
        {
          content: "Review v2 spec",
          priority: "high",
          status: "completed",
        },
        {
          content: "Implement TodoWrite",
          priority: "medium",
          status: "in_progress",
        },
      ],
      summary: {
        completed: 1,
        inProgress: 1,
        pending: 0,
        total: 2,
      },
    });
    expect(read).toEqual({
      todos: write.todos,
    });
  });

  it("allows multiple in-progress todos and updates state", async () => {
    const store = createTodoStore();
    const context = createContext(store);

    const write = await todoWriteHandler(
      {
        todos: [
          {
            content: "First active task",
            priority: "high",
            status: "in_progress",
          },
          {
            content: "Second active task",
            priority: "medium",
            status: "in_progress",
          },
        ],
      },
      context,
    );

    expect(write.summary.inProgress).toBe(2);
    await expect(todoReadHandler({}, context)).resolves.toEqual({ todos: write.todos });
  });

  it("parses serialized TodoRead and TodoWrite outputs for projections", () => {
    const todos: TodoItem[] = [
      {
        content: "Project ACP plan entries",
        priority: "high",
        status: "in_progress",
      },
    ];

    expect(todoItemsFromToolResultContent(JSON.stringify({ todos }))).toEqual(todos);
    expect(
      todoItemsFromToolResultContent(
        JSON.stringify({
          oldTodos: [],
          todos,
          summary: {
            completed: 0,
            inProgress: 1,
            pending: 0,
            total: 1,
          },
        }),
      ),
    ).toEqual(todos);
    expect(formatTodoStateForModel(todos)).toContain(
      "1. [in_progress][high] Project ACP plan entries",
    );
    expect(todoItemsFromToolResultContent("{not-json")).toBeUndefined();
  });
});

function createTodoStore(): SessionStorePort {
  const todos = new Map<string, TodoItem[]>();

  return {
    async readTodos(input) {
      return [...(todos.get(input.sessionID) ?? [])];
    },
    async updateTodos(input) {
      todos.set(
        input.sessionID,
        input.todos.map((todo) => ({ ...todo })),
      );
    },
  } as unknown as SessionStorePort;
}

function createContext(sessionStore: SessionStorePort): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: createSessionId("todo-tool"),
    sessionStore,
    toolCallId: "todo-call",
    traceId: "trace-todo" as never,
    workingDirectory: "/tmp/zcode-todo-tool",
    workspaceRoot: "/tmp/zcode-todo-tool",
  };
}
