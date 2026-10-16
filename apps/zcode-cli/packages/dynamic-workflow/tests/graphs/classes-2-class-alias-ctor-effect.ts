// A class aliased through a plain variable (`const Alias = Cfg`) and new'd through the
// alias. The constructor's SIDE EFFECT (writing the static field Cfg.last) is the only
// carrier: the instance value returned by `new Alias(secret)` is never used, so
// by-value arg folding cannot mask a missed constructor application.
// Runtime: new Alias(secret) runs the ctor => Cfg.last = secret => feeds ask#2.
// Expected: source -> ask#1, ask#1 -> ask#2 (ctor param -> Cfg.last), ask#2 -> sink.
const secret = await agent("writer").ask<string>("secret");
class Cfg {
  static last = "";
  constructor(x: string) {
    Cfg.last = x;
  }
}
const Alias = Cfg;
new Alias(secret);
const out = await agent("reader").ask<string>(`use ${Cfg.last}`);
return out;
