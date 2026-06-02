import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

export const HOME = homedir();

/** Read + parse JSON, tolerating trailing commas and // comments (Cursor allows both). */
export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const cleaned = text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Bounded-depth walk; skips node_modules and dot-dirs to stay fast. */
export async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.name.startsWith(".") && entry.name !== ".claude" && entry.name !== ".claude-plugin") continue;
      yield* walk(full, depth - 1);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/**
 * Minimal YAML frontmatter reader. Skills and subagents use a flat key/value
 * block, so a full YAML parser would be a dependency bought for nothing.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1 || line.startsWith("#") || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }
  return { data, body: text.slice(match[0].length) };
}
