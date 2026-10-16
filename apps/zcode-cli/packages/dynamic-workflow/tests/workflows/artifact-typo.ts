interface Verdict {
  approved: boolean;
}

const verdict = await agent("judge").ask<Verdict>("Judge this");
return verdict.aproved; // error
