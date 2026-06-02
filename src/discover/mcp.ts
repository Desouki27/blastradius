import { join, dirname, basename, resolve } from "node:path";
import { platform } from "node:os";
import type { ClientId, ConfigSource, McpServerSubject, Transport } from "../types.js";
import { HOME, exists, isRecord, readJson, walk } from "./fs.js";

export interface RawConfig {
  source: ConfigSource;
  data: Record<string, unknown>;
}

/** Claude Desktop's config lives in a different place on every OS. */
function claudeDesktopPath(): string {
  switch (platform()) {
    case "darwin":
      return join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(
        process.env.APPDATA ?? join(HOME, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    default:
      return join(HOME, ".config", "Claude", "claude_desktop_config.json");
  }
}

/**
 * `~/.claude.json` holds both the user's global servers and a per-project map,
 * so one file yields several sources.
 */
async function fromClaudeCode(): Promise<RawConfig[]> {
  const out: RawConfig[] = [];
  const path = join(HOME, ".claude.json");
  const data = await readJson(path);
  if (!data) return out;

  if (isRecord(data.mcpServers)) {
    out.push({ source: { client: "claude-code", path, scope: "global" }, data: { mcpServers: data.mcpServers } });
  }
  if (isRecord(data.projects)) {
    for (const [project, value] of Object.entries(data.projects)) {
      if (!isRecord(value) || !isRecord(value.mcpServers)) continue;
      if (Object.keys(value.mcpServers).length === 0) continue;
      out.push({
        source: { client: "claude-code", path, scope: "project", project },
        data: { mcpServers: value.mcpServers },
      });
    }
  }
  return out;
}

/** Plugins bundle their own `.mcp.json`, installed without a separate approval. */
async function fromPlugins(): Promise<RawConfig[]> {
  const root = join(HOME, ".claude", "plugins");
  if (!(await exists(root))) return [];
  const out: RawConfig[] = [];
  for await (const file of walk(root, 6)) {
    if (basename(file) !== ".mcp.json") continue;
    const data = await readJson(file);
    if (!data) continue;
    out.push({
      source: { client: "plugin", path: file, scope: "plugin", plugin: basename(dirname(file)) },
      data,
    });
  }
  return out;
}

async function fromFile(
  client: ClientId,
  path: string,
  scope: ConfigSource["scope"],
): Promise<RawConfig[]> {
  const data = await readJson(path);
  return data ? [{ source: { client, path, scope }, data }] : [];
}

/** Scan exactly one file, skipping discovery. Used by `--config` and in CI. */
export async function discoverOne(path: string): Promise<RawConfig[]> {
  const resolved = resolve(path);
  const data = await readJson(resolved);
  if (!data) throw new Error(`Could not read JSON from ${resolved}`);
  return [{ source: { client: "claude-code", path: resolved, scope: "project" }, data }];
}

export async function discoverMcpConfigs(cwd: string): Promise<RawConfig[]> {
  const results = await Promise.all([
    fromClaudeCode(),
    fromFile("claude-code", join(cwd, ".mcp.json"), "project"),
    fromPlugins(),
    fromFile("claude-desktop", claudeDesktopPath(), "global"),
    fromFile("cursor", join(HOME, ".cursor", "mcp.json"), "global"),
    fromFile("cursor", join(cwd, ".cursor", "mcp.json"), "project"),
    fromFile("windsurf", join(HOME, ".codeium", "windsurf", "mcp_config.json"), "global"),
    fromFile("vscode", join(cwd, ".vscode", "mcp.json"), "project"),
  ]);
  return results.flat();
}

// --- normalization ----------------------------------------------------------

/**
 * A value is a server definition if it carries a field that actually launches or
 * addresses something. This lets us accept the bare-map schema without
 * mistaking unrelated config keys for servers.
 */
function looksLikeServer(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    typeof value.command === "string" ||
    typeof value.url === "string" ||
    typeof value.type === "string" ||
    typeof value.serverUrl === "string"
  );
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

function detectTransport(def: Record<string, unknown>): Transport {
  const declared = typeof def.type === "string" ? def.type.toLowerCase() : undefined;
  if (declared === "http" || declared === "streamable-http" || declared === "streamablehttp") return "http";
  if (declared === "sse") return "sse";
  if (declared === "stdio") return "stdio";
  if (typeof def.command === "string") return "stdio";
  if (typeof def.url === "string" || typeof def.serverUrl === "string") return "http";
  return "unknown";
}

/**
 * Both schemas seen in the wild resolve here:
 *   { "mcpServers": { "name": {...} } }  - Claude Desktop, Cursor, most plugins
 *   { "name": {...} }                    - bare map, also used by official plugins
 */
export function normalize(config: RawConfig): McpServerSubject[] {
  const { data, source } = config;
  const container = isRecord(data.mcpServers)
    ? data.mcpServers
    : isRecord(data.servers) // VS Code uses "servers"
      ? data.servers
      : data;

  const specs: McpServerSubject[] = [];
  for (const [name, def] of Object.entries(container)) {
    if (!looksLikeServer(def)) continue;
    const args = Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === "string") : undefined;
    specs.push({
      kind: "mcp-server",
      name,
      transport: detectTransport(def),
      source,
      command: typeof def.command === "string" ? def.command : undefined,
      args,
      url:
        typeof def.url === "string"
          ? def.url
          : typeof def.serverUrl === "string"
            ? def.serverUrl
            : undefined,
      headers: toStringRecord(def.headers),
      env: toStringRecord(def.env),
      raw: def,
    });
  }
  return specs;
}
