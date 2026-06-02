#!/usr/bin/env node
import { parseArgs } from "node:util";
import { discoverAll, inventoryOne } from "./discover/index.js";
import { RULES, runRules } from "./rules/registry.js";
import { setParanoid } from "./rules/context.js";
import { renderJson, renderText } from "./report.js";
import { SEVERITY_ORDER, SURFACE_LABEL, type Severity, type SurfaceKind } from "./types.js";

const VERSION = "0.1.0";

const HELP = `
blastradius ${VERSION} - audit everything your AI coding agent trusts

Your agent will act on six kinds of configuration without asking you again.
Most tooling looks at one of them. This looks at all six:

  hooks         shell commands that run on every tool call, with no prompt
  skills        markdown loaded straight into the model's context
  instructions  CLAUDE.md files the agent follows
  subagents     agent definitions with their own tool grants
  permissions   what you already pre-approved
  MCP servers   third-party tool providers

USAGE
  blastradius [scan] [options]     Audit every surface on this machine
  blastradius rules                List the detection rules
  blastradius --help

OPTIONS
  --json                 Emit machine-readable JSON instead of a report
  --fail-on <severity>   Exit non-zero at or above this severity
                         (high | medium | low | info; default: high)
  --surface <kind>       Limit to one surface (repeatable)
  --config <path>        Audit a single MCP config file, skipping discovery
  --cwd <dir>            Directory to treat as the project root
  --paranoid             Also report prose matches that read as documentation
  --quiet                Suppress the report; exit code only

EXIT CODES
  0  no findings at or above the threshold
  1  findings at or above the threshold
  2  audit could not complete

blastradius reads configuration only. It never runs a configured server, never
executes a hook, and sends nothing anywhere.
`;

const SURFACES = Object.keys(SURFACE_LABEL) as SurfaceKind[];

function isSeverity(value: string): value is Severity {
  return value === "high" || value === "medium" || value === "low" || value === "info";
}

async function scan(options: {
  json: boolean;
  failOn: Severity;
  cwd: string;
  quiet: boolean;
  config?: string;
  surfaces: SurfaceKind[];
}): Promise<number> {
  const inventory = options.config ? await inventoryOne(options.config) : await discoverAll(options.cwd);

  const subjects = options.surfaces.length
    ? inventory.subjects.filter((s) => options.surfaces.includes(s.kind))
    : inventory.subjects;

  const findings = runRules(subjects);
  const input = { subjects, findings, fileCount: inventory.fileCount };

  if (!options.quiet) {
    process.stdout.write(options.json ? renderJson(input) + "\n" : renderText(input));
  }

  const threshold = SEVERITY_ORDER[options.failOn];
  return findings.some((f) => SEVERITY_ORDER[f.severity] <= threshold) ? 1 : 0;
}

function listRules(): number {
  process.stdout.write(`\nblastradius ${VERSION} - ${RULES.length} rules\n\n`);
  let current = "";
  for (const rule of RULES) {
    const surface = rule.appliesTo.map((k) => SURFACE_LABEL[k]).join(", ");
    if (surface !== current) {
      process.stdout.write(`  ${surface}\n`);
      current = surface;
    }
    process.stdout.write(`    ${rule.id.padEnd(26)} ${rule.description}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        paranoid: { type: "boolean", default: false },
        "fail-on": { type: "string", default: "high" },
        surface: { type: "string", multiple: true, default: [] },
        cwd: { type: "string", default: process.cwd() },
        config: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = positionals[0] ?? "scan";
  if (command === "rules") return listRules();
  if (command !== "scan") {
    process.stderr.write(`Unknown command: ${command}\nRun \`blastradius --help\`.\n`);
    return 2;
  }

  const failOn = values["fail-on"] as string;
  if (!isSeverity(failOn)) {
    process.stderr.write("--fail-on must be one of: high, medium, low, info\n");
    return 2;
  }

  const surfaces = values.surface as string[];
  const unknown = surfaces.filter((s) => !SURFACES.includes(s as SurfaceKind));
  if (unknown.length) {
    process.stderr.write(`Unknown surface: ${unknown.join(", ")}\nValid: ${SURFACES.join(", ")}\n`);
    return 2;
  }

  setParanoid(values.paranoid as boolean);

  return scan({
    json: values.json,
    failOn,
    cwd: values.cwd as string,
    quiet: values.quiet,
    config: values.config as string | undefined,
    surfaces: surfaces as SurfaceKind[],
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`blastradius failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
