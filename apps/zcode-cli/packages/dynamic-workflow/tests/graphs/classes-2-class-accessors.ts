// Class-declared accessors with DIFFERENT names (so the raw field write cannot mask the
// accessor path): the setter stores its parameter into this.hidden, the getter reads it
// back. Runtime: v.input = secret => setter => this.hidden = secret; v.output => getter
// => secret feeds ask#2.
// Expected: source -> ask#1, ask#1 -> ask#2 (setter param -> this.hidden -> getter), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Vault {
  hidden = "";
  set input(x: string) {
    this.hidden = x;
  }
  get output(): string {
    return this.hidden;
  }
}
const v = new Vault();
v.input = secret;
const out = await agent("reader").ask<string>(`use ${v.output}`);
return out;
