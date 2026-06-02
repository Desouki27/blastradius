import { homedir } from "node:os";
import type { Finding, PermissionSubject, Rule, Subject } from "../types.js";
import { makeFinding } from "../types.js";

/**
 * The allowlist is a standing decision. Each entry removes a prompt that would
 * otherwise have shown you the exact command before it ran, so an over-broad
 * entry is not a small convenience - it is the removal of the only checkpoint.
 */

const HOME = homedir();

/** Patterns that pre-approve arbitrary execution rather than a specific command. */
const WILDCARD_EXEC = /^Bash\(\s*(?:\*|:\*)?\s*\)$|^Bash$|^Bash\(\*\)$/i;

/** Specific commands whose blanket approval is worth surfacing. */
const RISKY_COMMANDS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(?:curl|wget)\b/i, why: "fetches from the network, which can pull code onto the machine" },
  { re: /\brm\s+-[rf]/i, why: "deletes recursively or forcibly" },
  { re: /\bsudo\b/i, why: "escalates privileges" },
  { re: /\bchmod\s+(?:\+x|777)/i, why: "makes files executable or world-writable" },
  { re: /\bgit\s+push\b/i, why: "publishes to a remote without a prompt" },
  { re: /\bnpm\s+publish\b|\bnpm\s+i(?:nstall)?\b/i, why: "installs or publishes packages, which runs lifecycle scripts" },
  { re: /\beval\b|\bbase64\s+-[dD]\b/i, why: "executes text as code" },
];

function asPermissions(subject: Subject): PermissionSubject {
  return subject as PermissionSubject;
}

/** A wildcard Bash grant is the whole shell, pre-approved. */
const wildcardExec: Rule = {
  id: "permission-wildcard-exec",
  description: "The allowlist pre-approves arbitrary shell execution",
  appliesTo: ["permissions"],
  check(subject) {
    const perms = asPermissions(subject);
    const matches = perms.allow.filter((entry) => WILDCARD_EXEC.test(entry.trim()));
    if (!matches.length) return [];
    return [
      makeFinding(
        perms,
        "permission-wildcard-exec",
        "high",
        "Any shell command is pre-approved",
        `Allowlist contains ${matches.join(", ")}, so every Bash invocation runs without showing you the command first.`,
        "Replace with specific grants, e.g. Bash(npm test), Bash(git status).",
      ),
    ];
  },
};

/** Named commands that deserve a look before they are made automatic. */
const riskyCommand: Rule = {
  id: "permission-risky-command",
  description: "The allowlist pre-approves a command with wide effects",
  appliesTo: ["permissions"],
  check(subject) {
    const perms = asPermissions(subject);
    const findings: Finding[] = [];
    for (const entry of perms.allow) {
      // A deny entry covering the same command means the decision was considered.
      if (perms.deny.some((d) => d.trim() === entry.trim())) continue;
      for (const { re, why } of RISKY_COMMANDS) {
        if (!re.test(entry)) continue;
        findings.push(
          makeFinding(
            perms,
            "permission-risky-command",
            "medium",
            "Pre-approves a command with wide effects",
            `${entry} runs without a prompt. It ${why}.`,
            "Narrow the pattern, or drop the entry and approve these case by case.",
          ),
        );
        break; // one finding per entry
      }
    }
    return findings;
  },
};

/** Directory grants widen what every other permission applies to. */
const broadDirectory: Rule = {
  id: "permission-broad-directory",
  description: "Additional working directories include the home directory or filesystem root",
  appliesTo: ["permissions"],
  check(subject) {
    const perms = asPermissions(subject);
    const broad = perms.additionalDirectories.filter((dir) => {
      const normalized = dir.replace(/^~(?=$|\/)/, HOME).replace(/\$HOME/g, HOME).replace(/\/+$/, "");
      return normalized === "/" || normalized === HOME;
    });
    if (!broad.length) return [];
    return [
      makeFinding(
        perms,
        "permission-broad-directory",
        "medium",
        "Agent may work across your entire home directory",
        `additionalDirectories includes ${broad.join(", ")}, which covers ~/.ssh, ~/.aws, and every other project on the machine.`,
        "List the specific project directories you actually work in.",
      ),
    ];
  },
};

export const PERMISSION_RULES: Rule[] = [wildcardExec, riskyCommand, broadDirectory];
