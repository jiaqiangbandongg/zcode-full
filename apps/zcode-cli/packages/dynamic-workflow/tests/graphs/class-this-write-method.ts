// A method writes its argument into this.field; a second method reads it back. The write
// through `this` mutates the shared instance, so the read connects writer -> reader.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Store {
  value = "";
  store(x: string) {
    this.value = x;
  }
  reveal(): string {
    return this.value;
  }
}
const s = new Store();
s.store(secret);
const out = await agent("reader").ask<string>(`use ${s.reveal()}`);
return out;
