// Two literal fan-outs in one script, the second consuming the first's results. The
// analyzer cannot pair member i with member i, so the hand-off is the honest complete
// bipartite may-relation: 2 writers × 2 critics = 4 edges. A third fan-out iterates the
// drafts themselves (an ask result) — unknowable length, so one `many` card.
interface Draft {
  text: string;
}
const PAIR = ["a", "b"];
const CRITICS = ["x", "y"] as const;
const drafts = await Promise.all(PAIR.map((t) => agent(`writer-${t}`).ask<Draft>(`write ${t}`)));
const reviews = await Promise.all(CRITICS.map((c) => agent(`critic-${c}`).ask<string>(`critique ${JSON.stringify(drafts)}`)));
const echoes = await Promise.all(drafts.map((d) => agent("echo").ask<string>(`echo ${d.text}`)));
return [...reviews, ...echoes];
