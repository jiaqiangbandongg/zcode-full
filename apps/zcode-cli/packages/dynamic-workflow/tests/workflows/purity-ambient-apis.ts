// Compile-time purity: ambient Node and web APIs do not exist in the script world.
process.exit(1); // error
await fetch("https://example.com"); // error
require("node:fs"); // error
await import("node:fs"); // error
