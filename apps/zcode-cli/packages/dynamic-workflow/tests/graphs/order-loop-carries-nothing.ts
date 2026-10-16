// A loop that repeats but carries NO data between rounds. The self-arrow must still
// appear: it comes from the ordering between consecutive iterations (the `await` in
// the body), not from the data.
const poller = agent("poller");
let seen = 0;
while (seen < 5) {
  await poller.ask<string>("poll once");
  seen += 1;
}
return seen;
