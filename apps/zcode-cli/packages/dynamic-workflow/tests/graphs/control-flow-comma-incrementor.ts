// Comma expression as the for-incrementor: the second operand's compound
// assignment accumulates taint each iteration.
const seed = await agent("scan").ask("seed");
let acc = "";
for (let i = 0; i < 3; i++, acc += seed) {
  log(String(i));
}
return agent("act").ask(`acc ${acc}`);
