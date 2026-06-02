import type { Finding, Rule, Subject } from "../types.js";
import { makeFinding } from "../types.js";
import { MCP_RULES } from "./mcp.js";
import { HOOK_RULES } from "./hooks.js";
import { PROMPT_RULES } from "./prompts.js";
import { PERMISSION_RULES } from "./permissions.js";

export const RULES: Rule[] = [...HOOK_RULES, ...PROMPT_RULES, ...PERMISSION_RULES, ...MCP_RULES];

export function runRules(subjects: Subject[]): Finding[] {
  const findings: Finding[] = [];
  for (const subject of subjects) {
    for (const rule of RULES) {
      if (!rule.appliesTo.includes(subject.kind)) continue;
      try {
        findings.push(...rule.check(subject));
      } catch (error) {
        // A broken rule must never take down the whole scan.
        findings.push(
          makeFinding(
            subject,
            rule.id,
            "info",
            `Rule ${rule.id} failed to run`,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }
  return findings;
}
