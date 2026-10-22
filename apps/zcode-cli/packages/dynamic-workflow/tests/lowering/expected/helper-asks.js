const solver = __host.createActor("actor#1", "solver");
async function solve(question) {
    const a = await __host.ask("ask#1", solver, question);
    return a.value;
}
const x = await solve("2 + 2");
const y = await solve("3 + 3");
return x + y;
