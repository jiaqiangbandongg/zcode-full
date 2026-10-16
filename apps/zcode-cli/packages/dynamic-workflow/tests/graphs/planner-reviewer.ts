interface Flaky {
  findings: {
    testId: string;
    /** 0-1, how confident the scan is */
    confidence: number;
  }[];
}

interface Review {
  approved: boolean;
  feedback: string;
}

const findings = await agent("scanner").ask<Flaky>("Find flaky tests");
log(`found ${findings.findings.length} findings`);

const planner = agent("planner", "You plan fixes...");
const reviewer = agent("reviewer", { system: "You critique plans..." });

let feedback = "none";
for (let round = 0; round < 5; round++) {
  const plan = await planner.ask<string>(`Plan fixes. Feedback: ${feedback}`);
  const review = await reviewer.ask<Review>(`Critique: ${plan}`);
  if (review.approved) return plan;
  feedback = review.feedback;
}

const verdicts = await Promise.all(
  findings.findings.map((f) => agent("judge").ask<Review>(`Judge: ${f.testId}`)),
);
return verdicts.filter((v) => v.approved).length;
