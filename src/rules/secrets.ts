/**
 * Credential detection, shared by the config rules and (later) the probe rules.
 *
 * The goal is a *literal* secret sitting in a config file, as distinct from a
 * placeholder that resolves at launch. `${GITHUB_TOKEN}` is correct usage;
 * `ghp_xxxxx...` checked into `.mcp.json` is the finding.
 */

/** Vendor-specific token shapes. High confidence, near-zero false positives. */
const KNOWN_TOKEN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "OpenAI API key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/ },
  { label: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/ },
  { label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { label: "Supabase/JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
];

/** Key names that mean "the value is sensitive", used for the entropy fallback. */
const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|apikey|credential|private[_-]?key|auth|bearer|access[_-]?key)/i;

/**
 * A value is a placeholder if it defers to the environment rather than
 * containing the secret itself. Covers `${VAR}`, `${VAR:-fallback}`, `$VAR`,
 * and the empty string.
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (/^\$\{[^}]*\}$/.test(trimmed)) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return true;
  // A value that is *entirely* interpolation, e.g. "Bearer ${TOKEN}".
  if (/^[^$]{0,16}\$\{[^}]*\}[^$]{0,16}$/.test(trimmed)) return true;
  return false;
}

/** Shannon entropy in bits per character. Random tokens land above ~3.5. */
export function entropy(value: string): number {
  if (!value.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export interface SecretHit {
  label: string;
  /** Enough of the value to recognize it, never enough to use it. */
  preview: string;
}

/** Show first/last few characters so the user can locate it without leaking it. */
export function redact(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}${"*".repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

/**
 * Classify one config value. `key` steers the entropy fallback; a high-entropy
 * string under `PATH` is a path, the same string under `API_KEY` is a secret.
 */
export function detectSecret(key: string, value: string): SecretHit | null {
  if (isPlaceholder(value)) return null;

  for (const { label, re } of KNOWN_TOKEN_PATTERNS) {
    if (re.test(value)) return { label, preview: redact(value) };
  }

  const trimmed = value.trim();
  if (
    SENSITIVE_KEY.test(key) &&
    trimmed.length >= 20 &&
    !trimmed.includes(" ") &&
    !trimmed.includes("/") &&
    entropy(trimmed) > 3.5
  ) {
    return { label: "high-entropy value in a credential field", preview: redact(trimmed) };
  }

  return null;
}
