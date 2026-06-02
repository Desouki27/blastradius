/**
 * Telling instruction from description.
 *
 * The hard problem in scanning prose is that a document *about* prompt
 * injection contains the same strings as a prompt injection. A security skill
 * that says: watch for text like "ignore previous instructions" is doing its
 * job, and flagging it teaches people to ignore the scanner - which costs more
 * than the miss would have.
 *
 * Three signals separate the two, and all of them are cheap:
 *   - code blocks and inline code are samples, not directives
 *   - a quoted phrase is being referred to, not issued
 *   - nearby words like "example", "attack", or "look for" frame what follows
 */

/**
 * Blank out fenced blocks and inline code, preserving length so that every
 * index and line number computed afterwards still points at the real file.
 */
export function stripCode(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/**
 * Words that frame a phrase as something being discussed. Deliberately broad:
 * suppressing a real finding is recoverable via --paranoid, whereas a scanner
 * that cries wolf gets uninstalled.
 */
const DISCUSSION_MARKER =
  /\b(?:(?<![.\w])examples?(?![.\w])|e\.g\.|i\.e\.|such as|for instance|like this|attack|attacker|adversar\w*|malicious|untrusted|injection|inject\w*|exploit|threat|vulnerab\w*|crafted|shaped like|spoof\w*|detect\w*|look for|looks? like|watch for|scan for|search for|check for|identify|identifying|flag\w*|warn\w*|suspicious|red flag|indicator|signal|symptom|smell|anti-?pattern|bad:|wrong:|incorrect|avoid|never|do not write|don't write|hunt\w*|signs? of|data,? never instructions|treat .{0,20}as data|not instructions)\b/i;

/** How far back to look for framing. About a paragraph. */
const WINDOW = 400;

/** Is the match wrapped in quotation marks? Then it is being referred to. */
function isQuoted(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 2);
  return /["'`“‘]\s*$/.test(before) && /^\s*["'`”’,.]/.test(after);
}

/**
 * True when the match reads as description rather than instruction, and should
 * not be reported unless the user asked for everything.
 */
export function isDiscussion(text: string, start: number, end: number): boolean {
  if (isQuoted(text, start, end)) return true;
  const before = text.slice(Math.max(0, start - WINDOW), start);
  // A URL is not framing prose. Without this, the reserved domain example.com
  // trips the "example" marker and suppresses whatever follows it - which is
  // exactly the text an exfiltration instruction would put in front of itself.
  return DISCUSSION_MARKER.test(before.replace(/\bhttps?:\/\/\S+/gi, " "));
}

/**
 * An explicit instruction *not* to move a secret. Guidance that says "never
 * reproduce the value" is the opposite of an exfiltration instruction, and it
 * usually appears just after the credential it is protecting - which the
 * backward-looking window above cannot see.
 *
 * Deliberately narrow: it matches a prohibition bound to a specific handling
 * verb, so "never tell the user" is not swept up with it.
 */
const PROHIBITION =
  /\b(?:never|do not|don't|must not|should not|avoid|refuse to)\s+(?:ever\s+)?(?:reproduce|include|copy|paste|share|log|print|expose|output|echo|write|store|commit|send|transmit|reveal)\b/i;

/** Look just past the match for guidance that forbids moving the secret. */
export function isProtected(text: string, end: number): boolean {
  return PROHIBITION.test(text.slice(end, end + 260));
}

/** Set by the CLI's --paranoid flag: report matches that look like discussion. */
let paranoid = false;
export function setParanoid(value: boolean): void {
  paranoid = value;
}
export function isParanoid(): boolean {
  return paranoid;
}
