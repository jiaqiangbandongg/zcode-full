const paths = await files.glob("src/**/*.ts");
const first = paths[0] ?? "none";
const content = await files.read(first);
log(`read ${content.length} bytes from ${first}`);
return paths.length;
