// Field chain 10 deep — beyond VALUE_DEPTH_CAP=8. The write lands at the leaf of
// the LIVE structure; reads clone (which folds structure past the cap into occs).
// The flow must survive the fold.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const o = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { leaf: "" } } } } } } } } } };
o.l1.l2.l3.l4.l5.l6.l7.l8.l9.leaf = await agent("writer").ask<string>("secret");
return agent("reader").ask<string>(`use ${o.l1.l2.l3.l4.l5.l6.l7.l8.l9.leaf}`);
