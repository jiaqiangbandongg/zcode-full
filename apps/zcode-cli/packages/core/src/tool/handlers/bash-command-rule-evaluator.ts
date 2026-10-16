import type { PermissionRuleBehavior, PermissionRuleValue } from "@zcode/contracts";
import { wildcardToRegExp } from "../../permission/rule-matching.js";

export interface BashRuleEvaluationInput {
  allSubjectGroups: readonly (readonly string[])[];
  behavior: PermissionRuleBehavior;
  exactCommands: readonly string[];
  requiredSubjectGroups: readonly (readonly string[])[];
  rules: readonly PermissionRuleValue[];
  safe: boolean;
}

export function evaluateBashRules(input: BashRuleEvaluationInput): boolean {
  if (input.rules.some((rule) => !rule.ruleContent)) return true;
  if (
    input.exactCommands.some((command) => command.length > 0) &&
    input.rules.some((rule) => input.exactCommands.includes(rule.ruleContent ?? ""))
  ) {
    return true;
  }
  if (!input.safe) return false;

  const subjectGroups =
    input.behavior === "allow" ? input.requiredSubjectGroups : input.allSubjectGroups;
  if (subjectGroups.length === 0) return false;
  if (input.behavior !== "allow") {
    return subjectGroups.some((subjects) =>
      subjects.some((subject) =>
        input.rules.some((rule) => matchesInvocationRule(subject, rule.ruleContent)),
      ),
    );
  }
  return subjectGroups.every((subjects) =>
    subjects.some((subject) =>
      input.rules.some((rule) => matchesInvocationRule(subject, rule.ruleContent)),
    ),
  );
}

function matchesInvocationRule(subject: string, ruleContent: string | undefined): boolean {
  if (!ruleContent) return true;
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`);
  }
  if (ruleContent.includes("*")) return wildcardToRegExp(ruleContent).test(subject);
  return subject === ruleContent;
}
