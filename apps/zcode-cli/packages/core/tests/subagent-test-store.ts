import type {
  CreateSessionInput,
  SessionId,
  SessionInfo,
  MessageInfo,
  MessagePart,
  ProjectId,
  PermissionRuleset,
  TodoItem,
  SessionStorePort,
  MessageWithParts,
} from "@zcode/contracts";

export function createRecordingSubagentSessionStore(): SessionStorePort {
  const sessions = new Map<SessionId, SessionInfo>();
  const entries = new Map<
    string,
    Parameters<NonNullable<SessionStorePort["saveSessionEntry"]>>[0]
  >();
  const messagesBySession = new Map<SessionId, MessageInfo[]>();
  const partsByMessage = new Map<string, MessagePart[]>();
  const permissionsByProject = new Map<ProjectId, PermissionRuleset>();
  const todosBySession = new Map<SessionId, TodoItem[]>();

  const store = {
    async saveSessionEntry(
      entry: Parameters<NonNullable<SessionStorePort["saveSessionEntry"]>>[0],
    ) {
      entries.set(entry.id, entry);
    },
    async sessionEntries({
      sessionID,
      type,
    }: Parameters<NonNullable<SessionStorePort["sessionEntries"]>>[0]) {
      return [...entries.values()].filter(
        (entry) => entry.sessionID === sessionID && (!type || entry.type === type),
      );
    },
    async createSession(input: CreateSessionInput): Promise<SessionInfo> {
      const now = Date.now();
      const session: SessionInfo = {
        id: input.id,
        projectID: input.projectID,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        traceID: input.traceID,
        taskType: input.taskType ?? "interactive",
        slug: input.slug,
        directory: input.directory,
        path: input.path,
        title: input.title,
        titleSource: input.titleSource,
        titleMessageID: input.titleMessageID,
        version: input.version,
        shareURL: input.shareURL,
        permission: input.permission,
        time: {
          created: input.time?.created ?? now,
          updated: input.time?.updated ?? input.time?.created ?? now,
        },
      };
      sessions.set(session.id, session);
      return session;
    },
    async updateSession(
      input: Parameters<SessionStorePort["updateSession"]>[0],
    ): Promise<SessionInfo> {
      const session = sessions.get(input.id);
      if (!session) {
        throw new Error(`Unknown session: ${input.id}`);
      }
      const updated: SessionInfo = {
        ...session,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.titleSource !== undefined ? { titleSource: input.titleSource } : {}),
        ...(input.titleMessageID !== undefined && input.titleMessageID !== null
          ? { titleMessageID: input.titleMessageID }
          : {}),
        time: {
          ...session.time,
          updated: Date.now(),
        },
      };
      sessions.set(updated.id, updated);
      return updated;
    },
    async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
      return sessions.get(sessionID) ?? null;
    },
    async listSessions(): Promise<SessionInfo[]> {
      return [...sessions.values()];
    },
    async saveMessage(input: MessageInfo): Promise<void> {
      const messages = messagesBySession.get(input.sessionID) ?? [];
      messages.push(input);
      messagesBySession.set(input.sessionID, messages);
    },
    async removeMessage(input: Parameters<SessionStorePort["removeMessage"]>[0]): Promise<void> {
      const messages = messagesBySession.get(input.sessionID) ?? [];
      messagesBySession.set(
        input.sessionID,
        messages.filter((message) => message.id !== input.messageID),
      );
      partsByMessage.delete(input.messageID);
    },
    async savePart(input: MessagePart): Promise<void> {
      const parts = partsByMessage.get(input.messageID) ?? [];
      parts.push(input);
      partsByMessage.set(input.messageID, parts);
    },
    async removePart(input: Parameters<SessionStorePort["removePart"]>[0]): Promise<void> {
      const parts = partsByMessage.get(input.messageID) ?? [];
      partsByMessage.set(
        input.messageID,
        parts.filter((part) => part.id !== input.partID),
      );
    },
    async messages(input): Promise<MessageWithParts[]> {
      return (messagesBySession.get(input.sessionID) ?? []).map((message) => ({
        info: message,
        parts: partsByMessage.get(message.id) ?? [],
      }));
    },
    async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
      return permissionsByProject.get(projectID) ?? null;
    },
    async saveProjectPermission(input: {
      permission: PermissionRuleset;
      projectID: ProjectId;
    }): Promise<PermissionRuleset> {
      permissionsByProject.set(input.projectID, input.permission);
      return input.permission;
    },
    async readTodos(input: { sessionID: SessionId }) {
      return todosBySession.get(input.sessionID) ?? [];
    },
    async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }) {
      todosBySession.set(input.sessionID, input.todos);
    },
  };

  return store as unknown as SessionStorePort;
}
