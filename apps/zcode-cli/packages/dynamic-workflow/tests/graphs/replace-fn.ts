// .replace with a replacement FUNCTION that returns tainted text. The keystone rule
// must analyze the replacer body so the taint it captures survives into `merged`.
const a = await agent("alpha").ask<string>("start");
const merged = "tt".replace(/t/g, () => a);
const b = await agent("beta").ask<string>(merged);
return b;
