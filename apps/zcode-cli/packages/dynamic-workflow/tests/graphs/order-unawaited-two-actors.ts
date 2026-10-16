// The same shape on TWO actors: genuinely concurrent. Expect NO edge between the two
// steps — concurrency is incomparability in the partial order, so it needs no ink.
const alpha = agent("alpha");
const beta = agent("beta");
const p1 = alpha.ask<string>("assess A");
const p2 = beta.ask<string>("assess B");
const [a, b] = await Promise.all([p1, p2]);
return `${a} ${b}`;
