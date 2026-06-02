import { homedir } from "node:os";
import type { Finding, Severity, Subject, SurfaceKind } from "./types.js";
import { SEVERITY_ORDER, SURFACE_LABEL } from "./types.js";
import { parseExec } from "./rules/exec.js";

const HOME = homedir();
const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const yellow = paint("33");
const blue = paint("34");
const gray = paint("90");
const green = paint("32");

const SEVERITY_STYLE: Record<Severity, (s: string) => string> = {
  high: red,
  medium: yellow,
  low: blue,
  info: gray,
};

/**
 * Ordered by how much a surface can do without asking, which is not the order
 * people expect: hooks run shell unprompted, skills rewrite the agent's
 * instructions, and MCP servers - the surface everyone scans - come last.
 */
const SURFACE_ORDER: SurfaceKind[] = [
  "hook",
  "skill",
  "instructions",
  "subagent",
  "permissions",
  "mcp-server",
];

export function tildify(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

/** One line saying what this subject actually is. */
function describe(subject: Subject): string {
  switch (subject.kind) {
    case "mcp-server": {
      if (subject.url) return subject.url;
      if (!subject.command) return "(no command)";
      const target = parseExec(subject.command, subject.args);
      if (target.kind === "unknown" || target.kind === "shell") {
        return truncate([subject.command, ...(subject.args ?? [])].join(" "), 68);
      }
      const separator = target.kind === "docker" ? ":" : "@";
      return `${subject.command} ${target.ref}${target.version ? separator + target.version : ""}`;
    }
    case "hook":
      return truncate(subject.command, 68);
    case "permissions":
      return `${subject.allow.length} allow, ${subject.deny.length} deny`;
    default:
      return tildify(subject.path);
  }
}

export function subjectTitle(subject: Subject): string {
  if (subject.kind === "hook") {
    return subject.matcher ? `${subject.event} - ${subject.matcher}` : subject.event;
  }
  return subject.name;
}

function originLabel(subject: Subject): string {
  const { client, scope, plugin, project } = subject.source;
  if (plugin) return `plugin:${plugin}`;
  if (project) return tildify(project);
  return `${client} ${scope}`;
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

export interface ReportInput {
  subjects: Subject[];
  findings: Finding[];
  fileCount: number;
}

export function renderText({ subjects, findings, fileCount }: ReportInput): string {
  const out: string[] = [];
  const width = Math.min(process.stdout.columns ?? 100, 100);

  out.push("");
  out.push(
    `${bold("blastradius")} ${dim(
      `${fileCount} file${fileCount === 1 ? "" : "s"}, ${subjects.length} trust surface${subjects.length === 1 ? "" : "s"}`,
    )}`,
  );
  out.push("");

  if (!subjects.length) {
    out.push(`  ${gray("Nothing configured for this agent on this machine.")}`);
    out.push("");
    return out.join("\n");
  }

  const byKey = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.kind}::${f.source.path}::${f.subject}`;
    const list = byKey.get(key);
    if (list) list.push(f);
    else byKey.set(key, [f]);
  }

  const findingsFor = (subject: Subject): Finding[] =>
    [...(byKey.get(`${subject.kind}::${subject.source.path}::${subject.name}`) ?? [])].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );

  for (const kind of SURFACE_ORDER) {
    const group = subjects.filter((s) => s.kind === kind);
    if (!group.length) continue;

    out.push(`  ${bold(SURFACE_LABEL[kind].toUpperCase())} ${gray(`(${group.length})`)}`);

    // Worst first, so each section opens on what matters.
    const ranked = [...group].sort((a, b) => {
      const rank = (s: Subject) => SEVERITY_ORDER[findingsFor(s)[0]?.severity ?? "info"];
      return rank(a) - rank(b);
    });

    for (const subject of ranked) {
      const own = findingsFor(subject);
      const worst = own.find((f) => f.severity !== "info");
      const dot = worst ? SEVERITY_STYLE[worst.severity]("*") : green("*");
      out.push(`  ${dot} ${bold(subjectTitle(subject))}  ${dim(describe(subject))}`);
      out.push(`      ${gray(originLabel(subject))}`);

      for (const f of own) {
        const tag = SEVERITY_STYLE[f.severity](f.severity.toUpperCase().padEnd(6));
        out.push(`      ${tag} ${f.title} ${gray(f.ruleId)}`);
        out.push(`             ${dim(wrap(f.detail, width - 14, " ".repeat(13)))}`);
        if (f.remediation) {
          out.push(`             ${gray("-> " + wrap(f.remediation, width - 16, " ".repeat(15)))}`);
        }
      }
    }
    out.push("");
  }

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const parts = (["high", "medium", "low", "info"] as const)
    .filter((s) => counts[s] > 0)
    .map((s) => SEVERITY_STYLE[s](`${counts[s]} ${s}`));

  out.push(parts.length ? `  ${parts.join(dim(" | "))}` : `  ${green("no findings")}`);
  out.push("");
  return out.join("\n");
}

export function renderJson({ subjects, findings, fileCount }: ReportInput): string {
  return JSON.stringify(
    {
      version: 1,
      scannedAt: new Date().toISOString(),
      fileCount,
      subjects: subjects.map((s) => ({
        kind: s.kind,
        name: subjectTitle(s),
        summary: describe(s),
        source: s.source,
      })),
      findings,
    },
    null,
    2,
  );
}
