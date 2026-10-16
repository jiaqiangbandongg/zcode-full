// A files.read world-input source feeding one ask.
const config = await files.read("config.json");
const summary = await agent("summarizer").ask<string>(`Summarize: ${config}`);
return summary;
