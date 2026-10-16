// String.raw tagged template laundering: taint must survive into the next ask.
const a = await agent("alpha").ask<string>("start");
const laundered = String.raw`prefix ${a} suffix`;
const b = await agent("beta").ask<string>(laundered);
return b;
