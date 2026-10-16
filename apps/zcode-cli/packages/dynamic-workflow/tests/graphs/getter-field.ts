// Object-literal getter: reading `.val` invokes the getter, whose return summary
// (the captured secret) must be the field's read value.
const secret = await agent("writer").ask<string>("secret");
const wrapper = {
  get val(): string {
    return secret;
  },
};
const out = await agent("reader").ask<string>(`use ${wrapper.val}`);
return out;
