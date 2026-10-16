import { UNPHASED_ID } from "./constants.js";
import type { PhaseInfo } from "./causality-order.js";
import type { Src } from "./flow-graph.js";

/**
 * Where a strand's exits wait between the `fork` that starts it and the `join` that
 * collects it — the one piece of state the concurrent control-flow graph (flow-graph.ts)
 * keeps outside its recursion over the control tree.
 *
 * A strand region is flowed at its SPAWN point, because that is where the trace records
 * it, but its exits do not belong there: they belong at the barrier that awaits its
 * promise, an arbitrary distance later in the leaf stream and possibly in another region.
 * So a strand parks its exits under its own region id and the spawner carries on
 * unchanged; the `settle` leaf whose `joins` names the region unparks them and merges them
 * into its own outgoing sources. A strand is joined at most once, exactly as the walk's
 * `joined` set says. Whatever is still parked when the root's sequence ends joins the
 * sink: nothing awaited it, so all that is known is that the script did not outlive it.
 *
 * The park also answers `alongside` for a `mark` leaf — which phases are still running
 * when this one is entered — which is why it carries each strand's phases and not only its
 * exits. Like every other projection module it must not import `typescript`; it is a
 * separate file only because flow-graph.ts sits at the 400-line cap.
 */
export interface StrandPark {
  /** Phases running alongside a mark: everything parked, minus its own and its ancestors'. */
  alongside: (phase: string, regions: readonly string[]) => string[];
  /** Forget everything parked, connecting nothing: a detached body's strands have no position. */
  discard: () => void;
  /** Take every exit still parked (the sink's share), leaving the park empty. */
  drain: () => Src[];
  /** Take the exits of the named strands; a name that parked nothing contributes none. */
  join: (regions: readonly string[]) => Src[];
  /** Record one strand's exits and the phases of the nodes its body created. */
  park: (region: string, exits: readonly Src[], phases: readonly string[]) => void;
}

/**
 * `phases` is the trace's phase table, which orders every list this module returns:
 * {@link UNPHASED_ID} first (as in `collectFlowPhases`), then first-reach order.
 */
export function createStrandPark(phases: readonly PhaseInfo[]): StrandPark {
  const parked = new Map<string, { exits: Src[]; phases: readonly string[] }>();
  const rank = new Map<string, number>(phases.map((phase, index) => [phase.id, index + 1]));
  rank.set(UNPHASED_ID, 0);
  const at = (id: string): number => rank.get(id) ?? rank.size;
  return {
    alongside: (phase, regions) => {
      // A mark inside a strand is not alongside it: the strand is where the mark IS. The
      // whole enclosing chain is excluded, not just the innermost region.
      const enclosing = new Set(regions);
      const running = new Set<string>();
      for (const [region, strand] of parked) {
        if (enclosing.has(region)) continue;
        for (const id of strand.phases) if (id !== phase) running.add(id);
      }
      return [...running].sort((a, b) => at(a) - at(b));
    },
    discard: () => parked.clear(),
    drain: () => {
      const out = [...parked.values()].flatMap((strand) => strand.exits);
      parked.clear();
      return out;
    },
    join: (regions) => {
      const out: Src[] = [];
      for (const region of regions) {
        const strand = parked.get(region);
        if (strand === undefined) continue;
        parked.delete(region);
        out.push(...strand.exits);
      }
      return out;
    },
    park: (region, exits, phaseIds) => {
      parked.set(region, { exits: [...exits], phases: [...phaseIds] });
    },
  };
}
