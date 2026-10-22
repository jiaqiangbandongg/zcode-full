import { createContext, useContext, type ReactNode } from "react";

const Context = createContext(true);

/** 仅投影 attachment 门禁；会话、草稿和消息继续留在既有 owner。 */
export function RemoteConversationAvailability({
  available,
  banner,
  children,
}: {
  available: boolean;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Context.Provider value={available}>
      <div className="flex h-full min-h-0 flex-1 flex-col">
        {!available ? banner : null}
        <div className="relative flex min-h-0 flex-1 flex-col" inert={!available}>
          <div className={available ? "contents" : "flex min-h-0 flex-1 flex-col opacity-60"}>
            {children}
          </div>
        </div>
      </div>
    </Context.Provider>
  );
}

export function useRemoteConversationAvailable() {
  return useContext(Context);
}
