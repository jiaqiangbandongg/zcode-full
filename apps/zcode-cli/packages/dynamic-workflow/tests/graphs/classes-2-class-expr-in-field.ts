// A class EXPRESSION stored in an object field and new'd through box.C. Runtime:
// inst.keep(secret) stores secret in this.stored; inst.reveal() returns it into ask#2.
// Probe: resolveClassNode only covers class-name identifiers and direct variable
// bindings — a class value in an object field escapes it. Does the flow degrade soundly?
// Expected: source -> ask#1, ask#1 -> ask#2 (keep -> this.stored -> reveal), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
const box = {
  C: class {
    stored = "";
    keep(x: string) {
      this.stored = x;
    }
    reveal(): string {
      return this.stored;
    }
  },
};
const inst = new box.C();
inst.keep(secret);
const out = await agent("reader").ask<string>(`use ${inst.reveal()}`);
return out;
