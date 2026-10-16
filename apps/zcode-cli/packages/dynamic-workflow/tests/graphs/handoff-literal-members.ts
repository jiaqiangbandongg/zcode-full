// Literal-length fan-out → one participant card per member (member=i/3), and a
// family → single-card hand-off inside ONE phase: every member hands to the one reviewer
// (3 edges, types carry the members' Draft). The const binding is never written, so its
// length counts.
interface Draft {
  topic: string;
  text: string;
}
phase("draft");
const TOPICS = ["sky", "sea", "soil"] as const;
const drafts = await Promise.all(TOPICS.map((t) => agent(`writer-${t}`).ask<Draft>(`write about ${t}`)));
const reviewer = agent("reviewer");
const verdict = await reviewer.ask<string>(`review ${JSON.stringify(drafts)}`);
return verdict;
