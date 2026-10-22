const findings = await __host.ask("ask#1", __host.createActor("actor#1", "scanner"), "Find flaky tests");
__host.log(`found ${findings.findings.length} findings`);
const planner = __host.createActor("actor#2", "planner", "You plan fixes...");
const reviewer = __host.createActor("actor#3", "reviewer", { system: "You critique plans..." });
let feedback = "none";
for (let round = 0; round < 5; round++) {
    const plan = await __host.ask("ask#2", planner, `Plan fixes. Feedback: ${feedback}`);
    const review = await __host.ask("ask#3", reviewer, `Critique: ${plan}`);
    if (review.approved)
        return plan;
    feedback = review.feedback;
}
const verdicts = await Promise.all(findings.findings.map((f) => __host.ask("ask#4", __host.createActor("actor#4", "judge"), `Judge: ${f.testId}`)));
return verdicts.filter((v) => v.approved).length;
