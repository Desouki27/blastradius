import type { Finding, PromptSubject, Rule, Subject } from "../types.js";
import { makeFinding } from "../types.js";
import { isDiscussion, isParanoid, isProtected, stripCode } from "./context.js";

/**
 * Skills, CLAUDE.md files, and subagent definitions are markdown that becomes
 * instructions to your agent. Writing to one of these files is the cheapest way
 * to change what an agent does: no code executes, nothing is installed, and a
 * diff full of prose reads as documentation.
 *
 * These rules look for text that addresses the *model* rather than the reader.
 */

interface Pattern {
  re: RegExp;
  why: string;
}

/** Instructions to conceal activity from the person the agent works for. */
const CONCEALMENT: Pattern[] = [
  { re: /\bdo(?:\s+not|n't)\s+(?:tell|inform|notify|alert|mention (?:this )?to)\s+(?:the\s+)?user\b/i, why: "instructs the agent to hide activity from you" },
  { re: /\bwithout\s+(?:telling|informing|notifying|alerting)\s+(?:the\s+)?user\b/i, why: "instructs the agent to act without telling you" },
  { re: /\b(?:silently|quietly)\s+(?:run|execute|send|upload|delete|modify|install)\b/i, why: "instructs the agent to act silently" },
  { re: /\bdo(?:\s+not|n't)\s+(?:log|record|report|display|show|output|surface)\s+(?:this|that|it|any\w*)\s+(?:to|for)\s+(?:the\s+)?(?:user|human|operator)\b/i, why: "instructs the agent to suppress reporting to you" },
  { re: /\bhide\s+(?:this|that|it|the\s+\w+)\s+from\s+(?:the\s+)?(?:user|human|operator)\b/i, why: "instructs the agent to hide something from you" },
];

/** Attempts to displace the operator's instructions. */
const OVERRIDE: Pattern[] = [
  { re: /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|above|preceding)\s+(?:instructions?|prompts?|rules?|directions?)\b/i, why: "attempts to override earlier instructions" },
  { re: /\bdisregard\s+(?:all\s+)?(?:previous|prior|earlier|your)\s+\w+/i, why: "attempts to discard earlier instructions" },
  { re: /\bregardless\s+of\s+what\s+(?:the\s+)?(?:user|human|operator)\s+says\b/i, why: "attempts to override your own instructions" },
  { re: /\boverride\s+your\s+(?:instructions?|guidelines?|rules?|safety)\b/i, why: "attempts to override the agent's guidelines" },
  { re: /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|debug|god|admin|unrestricted)\s+mode\b/i, why: "claims a privileged mode that does not exist" },
];

/** Attempts to skip the approval step that keeps a human in the loop. */
const AUTO_APPROVE: Pattern[] = [
  { re: /\bwithout\s+asking\s+(?:for\s+)?(?:permission|confirmation|the user)?\b/i, why: "instructs the agent to skip asking you" },
  { re: /\bdo(?:\s+not|n't)\s+ask\s+(?:for\s+)?(?:permission|confirmation|approval)\b/i, why: "instructs the agent not to seek approval" },
  { re: /\b(?:always\s+)?(?:auto[-\s]?)?approve\s+(?:all|any|every)\b/i, why: "instructs the agent to approve everything" },
  { re: /\bskip\s+(?:the\s+)?(?:confirmation|approval|permission)\b/i, why: "instructs the agent to skip confirmation" },
];

/** Text pointing the agent at credential material. */
const CREDENTIAL_REFERENCE =
  /(?:\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.env\b(?!\.(?:example|sample|template|dist))|\.netrc|keychain|private\s+key|AWS_SECRET|GITHUB_TOKEN|ANTHROPIC_API_KEY)/i;

/** How close a credential and a destination must be to count as one statement. */
const PROXIMITY = 220;

/** Verbs that move data outward. */
/**
 * A verb only moves data if it is being used as a verb. "Copying a secret into
 * a report" is advice against leaking; "report the secret to" is an instruction
 * to leak. An article or preposition in front marks the noun reading.
 */
const EXFIL_VERB =
  /(?<!\b(?:a|an|the|into|in|your|this|that|each|any|per|one|no|every)\s)\b(?:send|post|upload|transmit|exfiltrat\w*|report|forward|submit|beacon)(?:s|ing|ed)?\b/i;
const EXTERNAL_URL = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)\]]*/i;

/**
 * Characters that render as nothing but are read by the model: zero-width
 * spaces and joiners, bidirectional overrides, and Unicode tag characters -
 * the last of which can encode an entire hidden instruction in a file that
 * looks, to a reviewer, completely ordinary.
 */
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u;

function asPrompt(subject: Subject): PromptSubject {
  return subject as PromptSubject;
}

/** Report the line number so the finding points at something a reader can open. */
function locate(body: string, index: number): number {
  return body.slice(0, index).split("\n").length;
}

function scanPatterns(
  prompt: PromptSubject,
  patterns: Pattern[],
  ruleId: string,
  title: string,
  remediation: string,
): Finding[] {
  const raw = `${Object.values(prompt.frontmatter).join("\n")}\n${prompt.body}`;
  const haystack = stripCode(raw);

  for (const { re, why } of patterns) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const match of haystack.matchAll(global)) {
      const start = match.index ?? 0;
      if (!isParanoid() && isDiscussion(haystack, start, start + match[0].length)) continue;
      return [
        makeFinding(
          prompt,
          ruleId,
          "high",
          title,
          `Line ${locate(haystack, start)}: "${match[0].replace(/\s+/g, " ").trim()}" - ${why}.`,
          remediation,
        ),
      ];
    }
  }
  return [];
}

const concealment: Rule = {
  id: "prompt-concealment",
  description: "Instruction text tells the agent to hide what it is doing from you",
  appliesTo: ["skill", "instructions", "subagent"],
  check(subject) {
    return scanPatterns(
      asPrompt(subject),
      CONCEALMENT,
      "prompt-concealment",
      "Instructs the agent to conceal its activity",
      "Read this file in full. Legitimate instructions never need the agent to keep things from you.",
    );
  },
};

const override: Rule = {
  id: "prompt-override",
  description: "Instruction text attempts to displace the operator's own instructions",
  appliesTo: ["skill", "instructions", "subagent"],
  check(subject) {
    return scanPatterns(
      asPrompt(subject),
      OVERRIDE,
      "prompt-override",
      "Attempts to override your instructions",
      "Remove this file unless you wrote the line yourself and meant it.",
    );
  },
};

const autoApprove: Rule = {
  id: "prompt-auto-approve",
  description: "Instruction text tells the agent to act without asking you",
  appliesTo: ["skill", "instructions", "subagent"],
  check(subject) {
    return scanPatterns(
      asPrompt(subject),
      AUTO_APPROVE,
      "prompt-auto-approve",
      "Instructs the agent to skip asking you",
      "Confirm you intended to pre-authorize this; otherwise remove the line.",
    );
  },
};

/** The pairing is what matters: a credential mentioned *and* a way out. */
const credentialExfil: Rule = {
  id: "prompt-credential-exfil",
  description: "Instruction text references credentials alongside a way to send them somewhere",
  appliesTo: ["skill", "instructions", "subagent"],
  check(subject) {
    const prompt = asPrompt(subject);
    const body = stripCode(prompt.body);

    const credentials = [...body.matchAll(new RegExp(CREDENTIAL_REFERENCE.source, "gi"))];
    for (const credential of credentials) {
      const start = credential.index ?? 0;
      const end = start + credential[0].length;
      if (!isParanoid() && (isDiscussion(body, start, end) || isProtected(body, end))) continue;

      // The destination has to appear in the same breath as the credential. A
      // .env on line 41 and a docs link on line 400 are two unrelated facts.
      const window = body.slice(Math.max(0, start - PROXIMITY), start + PROXIMITY);
      const verb = EXFIL_VERB.exec(window);
      if (!verb) continue;
      const url = EXTERNAL_URL.exec(window);

      const destination = url
        ? ` alongside "${verb[0].trim()}" and an external URL (${url[0].slice(0, 60)})`
        : ` alongside "${verb[0].trim()}", a verb that moves data outward`;
      return [
        makeFinding(
          prompt,
          "prompt-credential-exfil",
          "high",
          "References credentials and a way to send them out",
          `Line ${locate(body, start)} mentions ${credential[0]}${destination} in the same passage.`,
          "Open this file and confirm what it actually instructs the agent to do.",
        ),
      ];
    }
    return [];
  },
};

/** Invisible to a reviewer, fully legible to the model. */
const hiddenCharacters: Rule = {
  id: "prompt-hidden-characters",
  description: "Instruction text contains characters that render as nothing",
  appliesTo: ["skill", "instructions", "subagent"],
  check(subject) {
    const prompt = asPrompt(subject);
    const match = INVISIBLE.exec(prompt.body);
    if (!match) return [];
    const codepoint = match[0].codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0");
    return [
      makeFinding(
        prompt,
        "prompt-hidden-characters",
        "high",
        "Contains invisible characters",
        `Line ${locate(prompt.body, match.index)} contains U+${codepoint}, which renders as nothing but is read by the model. Text hidden this way survives human review of the diff.`,
        "Strip non-printing characters from this file, then re-read what remains.",
      ),
    ];
  },
};

/** A subagent inherits whatever tools its definition grants it. */
const subagentBroadTools: Rule = {
  id: "subagent-broad-tools",
  description: "A subagent definition grants unrestricted tool access",
  appliesTo: ["subagent"],
  check(subject) {
    const prompt = asPrompt(subject);
    const tools = prompt.tools;
    if (!tools?.length) return [];
    const wildcard = tools.some((t) => t === "*" || t.toLowerCase() === "all");
    if (!wildcard) return [];
    return [
      makeFinding(
        prompt,
        "subagent-broad-tools",
        "medium",
        "Subagent is granted every tool",
        `${prompt.name} declares tools: ${tools.join(", ")}. It can run commands and edit files regardless of what its prompt says it is for.`,
        "List only the tools this subagent needs.",
      ),
    ];
  },
};

export const PROMPT_RULES: Rule[] = [
  hiddenCharacters,
  override,
  concealment,
  credentialExfil,
  autoApprove,
  subagentBroadTools,
];
