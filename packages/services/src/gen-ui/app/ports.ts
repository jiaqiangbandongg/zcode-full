import type { Event } from "@zcode/rpc";
import type {
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "@zcode/shared/gen-ui";
export interface GenUiStateStorage {
  get(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  set(target: GenUiStateTarget, state: GenUiWidgetState): Promise<void>;
  list(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onChanged: Event<GenUiStateChange>;
  dispose(): void;
}
