// Object-literal set accessor: assigning `box.val = secret` must record the assigned
// value as the setter's param, whose body captures it into `captured`, which a
// downstream ask reads. Setters are handled crudely (by property name, globally).
let captured = "";
const box = {
  set val(v: string) {
    captured = v;
  },
};
const secret = await agent("writer").ask<string>("secret");
box.val = secret;
const out = await agent("reader").ask<string>(`use ${captured}`);
return out;
