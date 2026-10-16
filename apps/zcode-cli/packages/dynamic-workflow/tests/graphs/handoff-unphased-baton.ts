// No phase markers: every participant sits in the one implicit `unphased` phase. A
// baton pass with no data (the editor's ask does not mention the draft) is still a
// hand-off — causality, not taint, is the relation — while the same-lane self-loop of
// the drafter's two asks dissolves.
const drafter = agent("drafter");
const editor = agent("editor");
const draft = await drafter.ask<string>("draft the memo");
const cleaned = await drafter.ask<string>(`tidy ${draft}`);
await editor.ask<string>("proofread whatever is in the shared doc");
return cleaned;
