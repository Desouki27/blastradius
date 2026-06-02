import { homedir } from "node:os";
import type { Finding, McpServerSubject, Rule, Subject } from "../types.js";
import { makeFinding } from "../types.js";
import { detectSecret } from "./secrets.js";
import { hasPipeToShell, parseExec } from "./exec.js";

const HOME = homedir();

/** Hosts that never leave the machine. */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".localhost")
  );
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The package or image is resolved at launch, not at approval. You reviewed one
 * version; the next launch may run whatever was published since.
 */
const unpinnedExec: Rule = {
  id: "unpinned-exec",
  description: "Server launches a package or image that is not pinned to a version",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.command) return [];
    const target = parseExec(server.command, server.args);
    if (target.pinned) return [];
    if (target.kind === "shell" || target.kind === "unknown") return []; // covered elsewhere

    const label =
      { npm: "npm package", pypi: "PyPI package", git: "git dependency", docker: "container image", script: "script" }[
        target.kind
      ] ?? "package";
    const separator = target.kind === "docker" ? ":" : "@";
    const shown = target.version ? `${target.ref}${separator}${target.version}` : target.ref;

    // A git ref has no immutable release to fall back on: whoever can push to the
    // branch decides what runs on your machine at next launch.
    const severity = target.kind === "git" ? "high" : "medium";
    const remediation =
      target.kind === "git"
        ? `Pin to a commit SHA or release tag, e.g. ${target.ref}@<sha>.`
        : target.kind === "docker"
          ? `Pin to an exact tag or a @sha256: digest, e.g. ${target.ref}:1.2.3.`
          : `Pin an exact version, e.g. ${target.ref}@1.2.3.`;

    return [
      makeFinding(
        server,
        "unpinned-exec",
        severity,
        `Runs an unpinned ${label}`,
        `${shown} resolves at launch time, so the code executed can change without any re-approval.`,
        remediation,
      ),
    ];
  },
};

/** A literal credential in a config file, rather than a reference to one. */
const hardcodedSecret: Rule = {
  id: "hardcoded-secret",
  description: "A credential is written literally into the config instead of referenced from the environment",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    const findings: Finding[] = [];
    const scan = (bag: Record<string, string> | undefined, where: string) => {
      for (const [key, value] of Object.entries(bag ?? {})) {
        const hit = detectSecret(key, value);
        if (!hit) continue;
        findings.push(
          makeFinding(
            server,
            "hardcoded-secret",
            "high",
            `Credential hardcoded in ${where}`,
            `${where}.${key} contains what looks like a ${hit.label} (${hit.preview}).`,
            "Replace with ${ENV_VAR} and rotate the exposed credential - config files get committed and synced.",
          ),
        );
      }
    };
    scan(server.env, "env");
    scan(server.headers, "headers");

    // Secrets also hide in argv, e.g. --token=ghp_xxx
    for (const arg of server.args ?? []) {
      const eq = arg.indexOf("=");
      if (eq === -1) continue;
      const hit = detectSecret(arg.slice(0, eq), arg.slice(eq + 1));
      if (!hit) continue;
      findings.push(
        makeFinding(
          server,
          "hardcoded-secret",
          "high",
          "Credential hardcoded in command arguments",
          `An argument contains what looks like a ${hit.label} (${hit.preview}). Arguments are also visible to any process that can read the process list.`,
          "Move it to an environment variable reference and rotate the credential.",
        ),
      );
    }
    return findings;
  },
};

/** Where your credentials and prompts actually travel. */
const credentialToRemote: Rule = {
  id: "credential-to-remote",
  description: "Credentials are forwarded to a remote endpoint",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.url) return [];
    const url = parseUrl(server.url);
    if (!url || isLocalHost(url.hostname)) return [];

    const bearers = [...Object.keys(server.headers ?? {}), ...Object.keys(server.env ?? {})].filter((k) =>
      /(?:secret|token|key|password|credential|auth)/i.test(k),
    );
    if (!bearers.length) return [];
    return [
      makeFinding(
        server,
        "credential-to-remote",
        "medium",
        "Sends credentials to a third-party host",
        `${url.host} receives ${bearers.join(", ")}. That host also sees every request this server handles on your behalf.`,
        `Confirm you trust ${url.host} with these credentials, and scope the token to the minimum this server needs.`,
      ),
    ];
  },
};

/** Plaintext transport to anywhere but this machine. */
const insecureTransport: Rule = {
  id: "insecure-transport",
  description: "Remote server is addressed over plaintext HTTP",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.url) return [];
    const url = parseUrl(server.url);
    if (!url) return [];
    if (url.protocol !== "http:" || isLocalHost(url.hostname)) return [];
    return [
      makeFinding(
        server,
        "insecure-transport",
        "high",
        "Remote server uses plaintext HTTP",
        `${server.url} is unencrypted, so tool calls, results, and any forwarded credentials travel in the clear.`,
        "Use https:// if the server supports it; otherwise treat this server as untrusted on any shared network.",
      ),
    ];
  },
};

/** Launching through a shell, or fetching code and piping it into one. */
const shellExec: Rule = {
  id: "shell-exec",
  description: "Server is launched through a shell or fetches code and pipes it to a shell",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.command) return [];
    const args = server.args ?? [];
    const findings: Finding[] = [];

    if (hasPipeToShell(args)) {
      findings.push(
        makeFinding(
          server,
          "shell-exec",
          "high",
          "Downloads and executes a remote script",
          `This server pipes a downloaded payload into a shell: ${args.join(" ").slice(0, 160)}`,
          "Vendor the script, review it, and run it from a known path instead of fetching it on every launch.",
        ),
      );
      return findings;
    }

    const target = parseExec(server.command, args);
    if (target.kind === "shell") {
      findings.push(
        makeFinding(
          server,
          "shell-exec",
          "medium",
          "Launched through a shell",
          `Command is a shell invocation: ${server.command} ${args.join(" ")}`.slice(0, 200),
          "Invoke the server binary directly so the launch command is not itself an injection surface.",
        ),
      );
    }
    return findings;
  },
};

/** How much of the filesystem the server was handed. */
const broadFilesystem: Rule = {
  id: "broad-filesystem",
  description: "Server is granted access to the home directory or filesystem root",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    const args = server.args ?? [];
    const broad: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const normalized = arg.replace(/^~(?=$|\/)/, HOME).replace(/\$HOME/g, HOME).replace(/\/+$/, "");
      if (normalized === "/" || normalized === HOME) broad.push(arg);
    }
    // Docker volume mounts get the same treatment.
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "-v" && args[i] !== "--volume" && args[i] !== "--mount") continue;
      const spec = args[i + 1];
      if (!spec) continue;
      const hostPath = spec.split(":")[0]?.replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, "");
      if (hostPath === "/" || hostPath === HOME) broad.push(spec);
    }
    if (!broad.length) return [];
    return [
      makeFinding(
        server,
        "broad-filesystem",
        "medium",
        "Granted access to your whole home directory or filesystem root",
        `Path argument: ${broad.join(", ")}. This includes ~/.ssh, ~/.aws, browser profiles, and every .env on the machine.`,
        "Narrow the grant to the specific project directories this server needs.",
      ),
    ];
  },
};

/** Not a defect - context the user needs when deciding what to trust. */
const remoteEndpoint: Rule = {
  id: "remote-endpoint",
  description: "Server is remote, so a third party receives your requests",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.url) return [];
    const url = parseUrl(server.url);
    if (!url || isLocalHost(url.hostname)) return [];
    return [
      makeFinding(
        server,
        "remote-endpoint",
        "info",
        `Remote server hosted at ${url.host}`,
        `Tool calls and their arguments - including file contents your agent passes in - are sent to ${url.host}.`,
      ),
    ];
  },
};

/** A local script is mutable by anything with write access to that path. */
const localScriptExec: Rule = {
  id: "local-script-exec",
  description: "Server runs a script from a local path rather than a published artifact",
  appliesTo: ["mcp-server"],
  check(subject) {
    const server = subject as McpServerSubject;
    if (!server.command) return [];
    const target = parseExec(server.command, server.args);
    if (target.kind !== "script") return [];
    return [
      makeFinding(
        server,
        "local-script-exec",
        "low",
        "Runs a local script",
        `${target.ref} is executed from disk, so its contents can change without any package or image update.`,
        "Track the file in version control, or lock it with `mcpsec lock` once file hashing lands.",
      ),
    ];
  },
};


export const MCP_RULES: Rule[] = [
  hardcodedSecret,
  insecureTransport,
  shellExec,
  unpinnedExec,
  credentialToRemote,
  broadFilesystem,
  localScriptExec,
  remoteEndpoint,
];
