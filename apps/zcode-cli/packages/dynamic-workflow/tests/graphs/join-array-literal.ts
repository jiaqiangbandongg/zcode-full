// Promise.all over a static array literal of asks — a join site whose argument
// is a visible array literal (the taint pass reads element positions as ports).
const [alpha, beta] = await Promise.all([
  agent("first").ask<string>("Task A"),
  agent("second").ask<string>("Task B"),
]);
return `${alpha} ${beta}`;
