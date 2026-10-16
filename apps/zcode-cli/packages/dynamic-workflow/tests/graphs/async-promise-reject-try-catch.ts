// Rejected promise awaited in a try: `await failure` THROWS the rejection reason
// (the scanner's output), the catch binding receives it, and it reaches the writer.
// Expected: ask#1 -> ask#2 data; ask#2 -> sink.
const finding = await agent("scanner").ask<string>("scan the repo");
const failure: Promise<string> = Promise.reject(finding);
let report = "ok";
try {
  await failure;
} catch (e) {
  report = String(e);
}
return agent("writer").ask<string>(`summarize: ${report}`);
