// A getter returns this.field; reading the getter (modeled as a field whose value is the
// getter's return summary) surfaces the stored artifact, connecting writer -> reader.
// Expected: source -> ask#1, ask#1 -> ask#2, ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Vault {
  stored: string;
  constructor(s: string) {
    this.stored = s;
  }
  get exposed(): string {
    return this.stored;
  }
}
const v = new Vault(secret);
const out = await agent("reader").ask<string>(`use ${v.exposed}`);
return out;
