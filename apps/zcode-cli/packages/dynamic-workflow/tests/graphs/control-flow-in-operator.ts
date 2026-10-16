// `in` operator over a tainted operand: the boolean depends on the ask's keys.
const report = await agent("scan").ask<Record<string, boolean>>("scan repo");
const flagged = "risk" in report;
return agent("act").ask(`flagged=${flagged}`);
