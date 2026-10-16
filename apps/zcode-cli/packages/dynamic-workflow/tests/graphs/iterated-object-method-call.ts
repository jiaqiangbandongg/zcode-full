// A method stored on an object that is ITERATED by a fan-out callback stays reachable:
// collapse carries the nested `run` function value through the element binding, so
// `h.run(secret)` dispatches to run's summary instead of collapsing to an unknown call.
// Expected: source -> ask#1, ask#1 -> ask#2 (secret into run's judge ask); fan-out#1 is
// present (the forEach body reaches a facade sink); no sink edge (return literal).
const secret = await agent("s").ask<string>("secret");
const handlers = [{ run: (x: string) => agent("j").ask<string>(`judge ${x}`) }];
handlers.forEach((h) => h.run(secret));
return "done";
