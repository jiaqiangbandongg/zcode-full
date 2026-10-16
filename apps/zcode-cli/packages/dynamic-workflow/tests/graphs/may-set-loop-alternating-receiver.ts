// An alternating receiver in a loop: the script's ONLY ask site is
// `(turn ? black : white).ask(…)`, so EVERY ask is a may-set — the shape that made the
// one-step rule erase an actor from the picture. Expansion draws two copies, one per
// candidate lane, and the loop's carry becomes the 2x2 product: the black <-> white
// alternation cycle plus a self-loop on each copy, since nothing rules out the same
// candidate being selected in consecutive rounds.
const black = agent("black");
const white = agent("white");
let board = "empty";
let turn = true;
while (board.length < 40) {
  board = await (turn ? black : white).ask<string>(`move on ${board}`);
  turn = !turn;
}
return board;
