// An agent's output becomes a file PATH (flows into a files.read argument), and the
// file content flows into a second agent. The only fixture exercising the
// actor -> workspace projection direction. Expect actor#namer -> workspace and
// workspace -> actor#reader: the two agents communicate via the workspace even
// though the world-read launders the direct path -> content site edge.
const namer = agent("namer");
const path = await namer.ask<string>("which file?");
const content = await files.read(path);
const reader = agent("reader");
const out = await reader.ask<string>(`content: ${content}`);
return out;
