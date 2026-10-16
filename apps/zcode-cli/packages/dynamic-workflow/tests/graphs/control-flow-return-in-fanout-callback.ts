// A `return` inside a fan-out callback ends THAT element's iteration: it targets the fanout
// region and reads as a `join via=return` on the CFG, never as a return from the script.
const paths = await files.glob("src/**/*.ts");
const reviews = await Promise.all(
  paths.map(async (file) => {
    const quick = await agent(`scan-${file}`).ask<string>(`quick scan ${file}`);
    if (quick === "skip") return quick;
    return agent(`deep-${file}`).ask<string>(`deep scan ${file}: ${quick}`);
  }),
);
return reviews;
