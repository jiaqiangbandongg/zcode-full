const paths = await __host.worldRead("world-read#1", "glob", ["src/**/*.ts"]);
const first = paths[0] ?? "none";
const content = await __host.worldRead("world-read#2", "read", [first]);
__host.log(`read ${content.length} bytes from ${first}`);
return paths.length;
