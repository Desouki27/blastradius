import type { HookSubject, Rule, Subject } from "../types.js";
import { makeFinding } from "../types.js";

/**
 * Hooks are the sharpest surface an agent exposes and the least examined.
 *
 * An MCP server offers tools the model may choose to call. A hook is not
 * offered to anyone: it runs shell on a lifecycle event, every time, with no
 * prompt. Registering it was the only approval, and anything that can append to
 * a settings file - a postinstall script, a synced dotfile, a merged PR - can
 * register one.
 */

/** Events that fire on ordinary agent activity, so a hook on them runs constantly. */
const HIGH_FREQUENCY_EVENTS = new Set(["PreToolUse", "PostToolUse", "UserPromptSubmit"]);

const NETWORK_TOOL = /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|rsync|http(?:ie)?)\b/;
const EXTERNAL_URL = /https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^\s"'`)]+/;

const CREDENTIAL_PATH =
  /(?:~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+)?\/?\.(?:ssh|aws|gnupg|kube|docker\/config|netrc)\b|\bid_rsa\b|\bid_ed25519\b|\.env(?:\.[\w.]+)?\b|\bcredentials\b|\bsecurity\s+find-generic-password\b|\bkeychain\b/i;

const OBFUSCATION =
  /\bbase64\s+(?:-d|-D|--decode)\b|\bxxd\s+-r\b|\beval\b|\|\s*(?:sh|bash|zsh)\b|\bpython3?\s+-c\b|\bnode\s+-e\b|\\x[0-9a-f]{2}/i;

function asHook(subject: Subject): HookSubject {
  return subject as HookSubject;
}

/** Every hook, listed. Most are legitimate; you should still know they exist. */
const hookRegistered: Rule = {
  id: "hook-registered",
  description: "A shell command is registered to run on an agent lifecycle event",
  appliesTo: ["hook"],
  check(subject) {
    const hook = asHook(subject);
    // "every tool call" is only accurate for the events that fire per tool;
    // SessionStart and Stop fire once, and saying otherwise overstates them.
    const scope =
      hook.matcher && hook.matcher !== "*"
        ? `on ${hook.matcher}`
        : HIGH_FREQUENCY_EVENTS.has(hook.event)
          ? "on every tool call"
          : `on ${hook.event}`;
    return [
      makeFinding(
        hook,
        "hook-registered",
        "info",
        `Runs a shell command ${scope}`,
        `${hook.event}: ${hook.command.slice(0, 140)}${hook.command.length > 140 ? "..." : ""}`,
      ),
    ];
  },
};

/** A hook that talks to the network turns every tool call into an outbound request. */
const hookNetworkEgress: Rule = {
  id: "hook-network-egress",
  description: "A hook sends data to an external host",
  appliesTo: ["hook"],
  check(subject) {
    const hook = asHook(subject);
    if (!NETWORK_TOOL.test(hook.command)) return [];
    const url = EXTERNAL_URL.exec(hook.command)?.[0];
    if (!url) return [];

    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep the raw match */
    }
    return [
      makeFinding(
        hook,
        "hook-network-egress",
        "high",
        "Sends data to an external host on every trigger",
        `The ${hook.event} hook contacts ${host}. Hook input includes the tool name and its arguments, which routinely contain file contents and file paths.`,
        `Confirm this hook is yours and that ${host} is meant to receive your tool activity.`,
      ),
    ];
  },
};

/** A hook reaching for credentials is doing something no telemetry hook needs. */
const hookReadsCredentials: Rule = {
  id: "hook-reads-credentials",
  description: "A hook references credential files or the system keychain",
  appliesTo: ["hook"],
  check(subject) {
    const hook = asHook(subject);
    const match = CREDENTIAL_PATH.exec(hook.command);
    if (!match) return [];
    return [
      makeFinding(
        hook,
        "hook-reads-credentials",
        "high",
        "References credentials",
        `The ${hook.event} hook mentions ${match[0]}. A formatting or logging hook has no reason to read credential material.`,
        "Read the hook command in full and remove it if you did not add it deliberately.",
      ),
    ];
  },
};

/** Encoded or indirected commands defeat the review the settings file invites. */
const hookObfuscated: Rule = {
  id: "hook-obfuscated",
  description: "A hook decodes, evaluates, or pipes its payload instead of stating it",
  appliesTo: ["hook"],
  check(subject) {
    const hook = asHook(subject);
    const match = OBFUSCATION.exec(hook.command);
    if (!match) return [];
    return [
      makeFinding(
        hook,
        "hook-obfuscated",
        "high",
        "Command is encoded or indirected",
        `The ${hook.event} hook uses ${match[0].trim()}, so what actually executes is not visible in the config: ${hook.command.slice(0, 120)}`,
        "Rewrite the hook so the command it runs is readable, or remove it.",
      ),
    ];
  },
};

/** Scope: a hook with no matcher fires on everything the agent does. */
const hookBroadMatcher: Rule = {
  id: "hook-broad-matcher",
  description: "A hook on a high-frequency event has no tool matcher",
  appliesTo: ["hook"],
  check(subject) {
    const hook = asHook(subject);
    if (!HIGH_FREQUENCY_EVENTS.has(hook.event)) return [];
    if (hook.matcher && hook.matcher !== "*" && hook.matcher !== "") return [];
    return [
      makeFinding(
        hook,
        "hook-broad-matcher",
        "medium",
        `Fires on every ${hook.event} with no matcher`,
        "This hook runs on every single tool call, receiving each tool's full arguments, rather than only the tools it needs.",
        'Add a "matcher" naming the specific tools this hook applies to.',
      ),
    ];
  },
};

export const HOOK_RULES: Rule[] = [
  hookNetworkEgress,
  hookReadsCredentials,
  hookObfuscated,
  hookBroadMatcher,
  hookRegistered,
];
