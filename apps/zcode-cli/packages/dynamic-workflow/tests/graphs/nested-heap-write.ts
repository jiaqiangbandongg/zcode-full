// Nested-target heap write (fix #4): an ask result assigned into a deeply nested
// object field (`report.sections.intro = r`). The assignment target's receiver
// `report.sections` is itself a member access, so there is no single field slot to
// update field-sensitively; the write falls back to weak-merging the ask taint into
// the leftmost identifier `report`. `report` reaches the return, so ask#1 must
// keep a data edge to the sink (a may-flow analysis must not drop the flow).
// Expected: source -> ask#1, ask#1 -> sink.
const report = { sections: { intro: "" } };
const r = await agent("writer").ask<string>("write the intro");
report.sections.intro = r;
return report;
