// Callback invocation family: the sweep's remaining job. `unused` is never applied by any
// call, so its ask is genuinely unreachable — the end-of-walk sweep still places it as a
// detached body, and that is the ONLY way a `detached` region arises now.
const unused = () => agent("ghost").ask<string>("never");
const real = await agent("worker").ask<string>("do it");
return real;
