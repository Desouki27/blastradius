/**
 * Everything a coding agent will trust without asking you again.
 *
 * MCP servers are the surface people know about. They are also the least
 * dangerous of the six: a hook runs shell on every tool call with no prompt at
 * all, and a skill injects instructions directly into the model's context.
 */
export type SurfaceKind =
  | "mcp-server"
  | "hook"
  | "skill"
  | "instructions"
  | "subagent"
  | "permissions";

export type ClientId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "windsurf"
  | "vscode"
  | "plugin";

export interface ConfigSource {
  client: ClientId;
  /** Absolute path to the file the definition came from. */
  path: string;
  scope: "global" | "project" | "plugin";
  /** Project directory, when scope is "project". */
  project?: string;
  /** Plugin name, when scope is "plugin". */
  plugin?: string;
}

export interface BaseSubject {
  name: string;
  source: ConfigSource;
}

export type Transport = "stdio" | "http" | "sse" | "unknown";

/** A third-party tool provider, launched locally or reached over the network. */
export interface McpServerSubject extends BaseSubject {
  kind: "mcp-server";
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  raw: Record<string, unknown>;
}

/**
 * A shell command the agent runs on a lifecycle event. There is no approval
 * prompt at fire time - registering the hook was the approval, and anything
 * that can write to a settings file can register one.
 */
export interface HookSubject extends BaseSubject {
  kind: "hook";
  /** PreToolUse, PostToolUse, Stop, SessionStart, ... */
  event: string;
  /** Which tools it fires on. Absent or "*" means all of them. */
  matcher?: string;
  hookType: string;
  command: string;
  timeout?: number;
}

/**
 * Markdown whose contents are loaded into the model's context: a skill, a
 * CLAUDE.md, or a subagent definition. Whoever writes this text is issuing
 * instructions to your agent.
 */
export interface PromptSubject extends BaseSubject {
  kind: "skill" | "instructions" | "subagent";
  path: string;
  frontmatter: Record<string, string>;
  body: string;
  /** Tool grants declared by a subagent definition. */
  tools?: string[];
}

/** Pre-approved actions: what the agent may do without stopping to ask. */
export interface PermissionSubject extends BaseSubject {
  kind: "permissions";
  allow: string[];
  deny: string[];
  additionalDirectories: string[];
}

export type Subject = McpServerSubject | HookSubject | PromptSubject | PermissionSubject;

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** One line: what is true. */
  title: string;
  /** The specifics - which argument, which header, which line. */
  detail: string;
  /** What to do about it. */
  remediation?: string;
  subject: string;
  kind: SurfaceKind;
  source: ConfigSource;
}

export interface Rule {
  id: string;
  description: string;
  /** Which surfaces this rule inspects. */
  appliesTo: SurfaceKind[];
  check(subject: Subject): Finding[];
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  "mcp-server": "MCP server",
  hook: "hook",
  skill: "skill",
  instructions: "instructions",
  subagent: "subagent",
  permissions: "permissions",
};

/** Helper used by every rule to build a finding without repeating the plumbing. */
export function makeFinding(
  subject: Subject,
  ruleId: string,
  severity: Severity,
  title: string,
  detail: string,
  remediation?: string,
): Finding {
  return {
    ruleId,
    severity,
    title,
    detail,
    remediation,
    subject: subject.name,
    kind: subject.kind,
    source: subject.source,
  };
}
