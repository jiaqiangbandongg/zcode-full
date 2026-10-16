// A `throw` inside a catch block does not land back in the same try: `catch` is a sibling of
// `attempt`, so the jump resolves to the OUTER attempt — here there is none, so it aborts.
// The step inside the try body may-throws into the catch; the step inside the catch has no
// implicit exception edge (only try bodies get one).
const plan = await agent("planner").ask<string>("plan");
let result = "";
try {
  result = await agent("worker").ask<string>(`do: ${plan}`);
} catch {
  const salvage = await agent("salvage").ask<string>(`salvage: ${plan}`);
  if (salvage === "") throw new Error("unrecoverable");
  result = salvage;
}
return result;
