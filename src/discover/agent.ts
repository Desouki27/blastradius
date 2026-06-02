import { basename, dirname, join, relative } from "node:path";
import type { ConfigSource, HookSubject, PermissionSubject, PromptSubject } from "../types.js";
import { HOME, exists, isRecord, parseFrontmatter, readJson, readText, walk } from "./fs.js";

/** Settings files, in the order the agent layers them. */
function settingsPaths(cwd: string): Array<{ path: string; source: ConfigSource }> {
  return [
    {
      path: join(HOME, ".claude", "settings.json"),
      source: { client: "claude-code", path: join(HOME, ".claude", "settings.json"), scope: "global" },
    },
    {
      path: join(cwd, ".claude", "settings.json"),
      source: {
        client: "claude-code",
        path: join(cwd, ".claude", "settings.json"),
        scope: "project",
        project: cwd,
      },
    },
    {
      path: join(cwd, ".claude", "settings.local.json"),
      source: {
        client: "claude-code",
        path: join(cwd, ".claude", "settings.local.json"),
        scope: "project",
        project: cwd,
      },
    },
  ];
}

/**
 * Hooks are stored as `{ event: [{ matcher, hooks: [{ type, command }] }] }`.
 * One event can carry many matchers, and one matcher many commands, so a single
 * settings file can register a dozen shell commands in one nested block.
 */
function extractHooks(data: Record<string, unknown>, source: ConfigSource): HookSubject[] {
  if (!isRecord(data.hooks)) return [];
  const out: HookSubject[] = [];

  for (const [event, groups] of Object.entries(data.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const entries = Array.isArray(group.hooks) ? group.hooks : [];
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const command = typeof entry.command === "string" ? entry.command : "";
        if (!command) continue;
        out.push({
          kind: "hook",
          name: matcher ? `${event}:${matcher}` : event,
          source,
          event,
          matcher,
          hookType: typeof entry.type === "string" ? entry.type : "command",
          command,
          timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
        });
      }
    }
  }
  return out;
}

function extractPermissions(
  data: Record<string, unknown>,
  source: ConfigSource,
): PermissionSubject[] {
  if (!isRecord(data.permissions)) return [];
  const p = data.permissions;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

  const allow = list(p.allow);
  const deny = list(p.deny);
  const additionalDirectories = list(p.additionalDirectories);
  if (!allow.length && !deny.length && !additionalDirectories.length) return [];

  return [
    {
      kind: "permissions",
      name: source.scope === "global" ? "user permissions" : "project permissions",
      source,
      allow,
      deny,
      additionalDirectories,
    },
  ];
}

export async function discoverSettings(
  cwd: string,
): Promise<{ hooks: HookSubject[]; permissions: PermissionSubject[] }> {
  const hooks: HookSubject[] = [];
  const permissions: PermissionSubject[] = [];

  for (const { path, source } of settingsPaths(cwd)) {
    const data = await readJson(path);
    if (!data) continue;
    hooks.push(...extractHooks(data, source));
    permissions.push(...extractPermissions(data, source));
  }

  // Plugins ship hooks too, and installing the plugin is the only approval.
  const pluginRoot = join(HOME, ".claude", "plugins");
  if (await exists(pluginRoot)) {
    for await (const file of walk(pluginRoot, 6)) {
      if (basename(file) !== "hooks.json") continue;
      const data = await readJson(file);
      if (!data) continue;
      const plugin = pluginName(file);
      hooks.push(...extractHooks(data, { client: "plugin", path: file, scope: "plugin", plugin }));
    }
  }

  return { hooks, permissions };
}

/** Recover the plugin's directory name from a path inside it. */
function pluginName(file: string): string {
  const parts = file.split("/");
  const idx = parts.lastIndexOf("plugins");
  const external = parts.lastIndexOf("external_plugins");
  const anchor = Math.max(idx, external);
  return anchor >= 0 && parts[anchor + 1] ? parts[anchor + 1]! : basename(dirname(file));
}

/** A markdown file whose contents are loaded into the model's context. */
async function promptFile(
  path: string,
  kind: PromptSubject["kind"],
  source: ConfigSource,
  name?: string,
): Promise<PromptSubject | null> {
  const text = await readText(path);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  return {
    kind,
    name: name ?? data.name ?? basename(dirname(path)),
    source,
    path,
    frontmatter: data,
    body,
    tools: data.tools ? data.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
  };
}

/**
 * Skills, CLAUDE.md files, and subagent definitions. All three are text that
 * becomes instructions to the agent, so they share one shape and one rule set.
 */
export async function discoverPrompts(cwd: string): Promise<PromptSubject[]> {
  const out: PromptSubject[] = [];

  const push = async (path: string, kind: PromptSubject["kind"], source: ConfigSource, name?: string) => {
    const subject = await promptFile(path, kind, source, name);
    if (subject) out.push(subject);
  };

  // CLAUDE.md - instructions the agent follows, frequently committed to the repo.
  for (const [path, scope] of [
    [join(HOME, ".claude", "CLAUDE.md"), "global"],
    [join(cwd, "CLAUDE.md"), "project"],
    [join(cwd, ".claude", "CLAUDE.md"), "project"],
  ] as const) {
    await push(path, "instructions", {
      client: "claude-code",
      path,
      scope,
      project: scope === "project" ? cwd : undefined,
    }, basename(path));
  }

  // Skills and subagents, from the user directory and from every plugin.
  const roots: Array<{ dir: string; scope: ConfigSource["scope"] }> = [
    { dir: join(HOME, ".claude"), scope: "global" },
    { dir: join(cwd, ".claude"), scope: "project" },
    { dir: join(HOME, ".claude", "plugins"), scope: "plugin" },
  ];

  for (const { dir, scope } of roots) {
    if (!(await exists(dir))) continue;
    for await (const file of walk(dir, 7)) {
      const base = basename(file);
      const isSkill = base === "SKILL.md";
      const isAgent = base.endsWith(".md") && relative(dir, file).split("/").includes("agents");
      if (!isSkill && !isAgent) continue;

      const source: ConfigSource = {
        client: scope === "plugin" ? "plugin" : "claude-code",
        path: file,
        scope,
        project: scope === "project" ? cwd : undefined,
        plugin: scope === "plugin" ? pluginName(file) : undefined,
      };
      await push(file, isSkill ? "skill" : "subagent", source, isAgent ? base.replace(/\.md$/, "") : undefined);
    }
  }

  return out;
}
