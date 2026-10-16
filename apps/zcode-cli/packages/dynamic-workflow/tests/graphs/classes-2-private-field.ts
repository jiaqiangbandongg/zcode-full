// A #private field carries taint: put() writes this.#x, take() reads it back.
// Runtime: s.put(secret) => this.#x = secret; s.take() => secret feeds ask#2.
// Probe: PrivateIdentifier property keys must be consistent between write and read.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Safe {
  #x = "";
  put(v: string) {
    this.#x = v;
  }
  take(): string {
    return this.#x;
  }
}
const s = new Safe();
s.put(secret);
const out = await agent("reader").ask<string>(`use ${s.take()}`);
return out;
