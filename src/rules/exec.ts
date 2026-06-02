/**
 * Parsing what a stdio server actually executes.
 *
 * `npx -y some-mcp-server` looks harmless and is the single most common way an
 * MCP server is launched, but it resolves to whatever the registry serves at
 * launch time. Knowing *which* argument is the package, and whether it carries
 * a version, is the difference between "you run v1.2.3" and "you run whatever
 * they publish next".
 */

export interface ExecTarget {
  /** The package, image, or script that ultimately runs. */
  ref: string;
  kind: "npm" | "pypi" | "git" | "docker" | "script" | "shell" | "unknown";
  /** Version, tag, or digest, when one is present. */
  version?: string;
  pinned: boolean;
}

/** Runtimes that fetch-and-run from a public registry. */
const NPM_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const PY_RUNNERS = new Set(["uvx", "pipx"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);

/** npx flags that consume the following argument. */
const NPM_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--registry", "--userconfig"]);

/** docker-run flags that consume the following argument. */
const DOCKER_VALUE_FLAGS = new Set([
  "-e", "--env", "-v", "--volume", "-p", "--publish", "--name", "-w", "--workdir",
  "--network", "--net", "-u", "--user", "--entrypoint", "--mount", "--label", "-l",
  "--env-file", "--add-host", "--platform",
]);

function basenameOf(command: string): string {
  const parts = command.split(/[/\\]/);
  return parts[parts.length - 1] ?? command;
}

/** Split `@scope/name@1.2.3` into name and version without tripping on the scope `@`. */
function splitPackageSpec(spec: string): { name: string; version?: string } {
  const scoped = spec.startsWith("@");
  const body = scoped ? spec.slice(1) : spec;
  const at = body.indexOf("@");
  if (at === -1) return { name: spec };
  return {
    name: (scoped ? "@" : "") + body.slice(0, at),
    version: body.slice(at + 1),
  };
}

/** A version is a pin if it names one release. Ranges and tags are not pins. */
function isPinnedVersion(version: string | undefined): boolean {
  if (!version) return false;
  if (version === "latest" || version === "next" || version === "canary" || version === "beta") return false;
  if (/^[\^~*]/.test(version) || version.includes("x") || version.includes(" ")) return false;
  return /^\d/.test(version) || version.startsWith("sha256:");
}

/**
 * A git dependency resolves to whatever HEAD of that branch is at launch. Unlike
 * a registry release, nothing about it is immutable - the maintainer (or anyone
 * who compromises the repo) can change what you run by pushing a commit.
 */
function parseGitSpec(arg: string): ExecTarget | null {
  if (!/^(?:git\+|github:|git@|https:\/\/(?:github|gitlab)\.com\/)/.test(arg)) return null;
  const lastSlash = arg.lastIndexOf("/");
  const at = arg.indexOf("@", lastSlash + 1);
  if (at === -1) return { ref: arg, kind: "git", pinned: false };
  const rev = arg.slice(at + 1);
  const mutable = rev === "main" || rev === "master" || rev === "HEAD" || rev === "";
  return { ref: arg.slice(0, at), kind: "git", version: rev, pinned: !mutable };
}

function parseNpmRunner(args: string[]): ExecTarget | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (NPM_VALUE_FLAGS.has(arg)) {
      i++; // skip this flag's value
      continue;
    }
    if (arg.startsWith("-")) continue;
    const git = parseGitSpec(arg);
    if (git) return git;
    const { name, version } = splitPackageSpec(arg);
    return { ref: name, kind: "npm", version, pinned: isPinnedVersion(version) };
  }
  return null;
}

function parsePyRunner(args: string[]): ExecTarget | null {
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const git = parseGitSpec(arg);
    if (git) return git;
    const at = arg.lastIndexOf("==");
    if (at > 0) {
      const version = arg.slice(at + 2);
      return { ref: arg.slice(0, at), kind: "pypi", version, pinned: isPinnedVersion(version) };
    }
    return { ref: arg, kind: "pypi", pinned: false };
  }
  return null;
}

function parseDocker(args: string[]): ExecTarget | null {
  const runIdx = args.findIndex((a) => a === "run" || a === "create");
  if (runIdx === -1) return null;
  for (let i = runIdx + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (DOCKER_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    // First bare argument after the flags is the image reference.
    const digest = arg.indexOf("@sha256:");
    if (digest !== -1) {
      return { ref: arg.slice(0, digest), kind: "docker", version: arg.slice(digest + 1), pinned: true };
    }
    // A colon after the last slash is a tag, not a registry port.
    const lastSlash = arg.lastIndexOf("/");
    const colon = arg.indexOf(":", lastSlash + 1);
    if (colon === -1) return { ref: arg, kind: "docker", pinned: false };
    const tag = arg.slice(colon + 1);
    return { ref: arg.slice(0, colon), kind: "docker", version: tag, pinned: tag !== "latest" };
  }
  return null;
}

/** Resolve a command + args into the thing that actually executes. */
export function parseExec(command: string, args: string[] = []): ExecTarget {
  const bin = basenameOf(command);

  if (NPM_RUNNERS.has(bin)) {
    return parseNpmRunner(args) ?? { ref: command, kind: "npm", pinned: false };
  }
  if (PY_RUNNERS.has(bin)) {
    return parsePyRunner(args) ?? { ref: command, kind: "pypi", pinned: false };
  }
  if (bin === "docker" || bin === "podman") {
    return parseDocker(args) ?? { ref: command, kind: "docker", pinned: false };
  }
  if (SHELLS.has(bin)) {
    return { ref: args.join(" ") || bin, kind: "shell", pinned: false };
  }
  // node/python/deno running a local file, or a binary on PATH. A local script is
  // whatever is on disk right now, which is a different trust question entirely.
  const scriptArg = args.find((a) => !a.startsWith("-") && /\.(m?[jt]s|py|rb|sh)$/.test(a));
  if (scriptArg) return { ref: scriptArg, kind: "script", pinned: true };
  if (command.includes("/") || command.includes("\\")) {
    return { ref: command, kind: "script", pinned: true };
  }
  return { ref: command, kind: "unknown", pinned: true };
}

/** Detect `curl ... | sh` and friends anywhere in the argument vector. */
export function hasPipeToShell(args: string[]): boolean {
  const joined = args.join(" ");
  return /(?:curl|wget|fetch)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(joined);
}
