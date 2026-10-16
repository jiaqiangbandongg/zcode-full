// Optional-chaining reads (d?.core.text) off a nullable ask result must flow.
interface Detail {
  core: { text: string };
}
const d = await agent("scan").ask<Detail | null>("detail");
const t = d?.core.text ?? "none";
return agent("act").ask(`use ${t}`);
