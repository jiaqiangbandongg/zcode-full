// Agent-relevance filter: a world read flowing straight into the script result, no
// agent involved. The site graph must keep source -> world#1 and world#1 -> sink
// (honest plumbing); the actor projection must hide workspace -> sink (no actor
// endpoint) and prune every dangling endpoint, leaving an EMPTY actor graph.
const listing = await files.glob("src/**");
return listing.join("\n");
