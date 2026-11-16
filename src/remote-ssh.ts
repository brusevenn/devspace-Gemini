import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { REMOTE_HELPER } from "./remote-ssh-python.js";

interface SshProject { name: string; host: string; root: string }

interface RemoteSession extends SshProject { id: string }

interface RemoteResult {
  result: string;
  sha256?: string;
  changed?: boolean;
  exit_code?: number;
}

type RemoteInput =
  | { op: "open" }
  | { op: "read"; path: string; offset?: number; limit?: number }
  | { op: "write"; path: string; content: string; expected_sha256?: string }
  | { op: "edit"; path: string; expected_sha256: string; edits: { old_text: string; new_text: string }[] }
  | { op: "exec"; command: string; cwd?: string; timeout?: number }
  | { op: "status" };

const remoteResponseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    result: z.string(),
    sha256: z.string().optional(),
    changed: z.boolean().optional(),
    exit_code: z.number().optional(),
  }).optional(),
  error: z.string().optional(),
});

const projectSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  root: z.string().startsWith("/").min(3).max(1000),
}).strict();

const configurationSchema = z.object({ projects: z.array(projectSchema).max(32) }).strict();
const MAX_SSH_OUTPUT_BYTES = 2 * 1024 * 1024;
const sessionsByConfigDir = new Map<string, RemoteSshBridge>();

export function loadRemoteSshProjects(configDir: string): SshProject[] {
  const path = join(configDir, "remote-ssh.json");

  if (!existsSync(path)) return [];
  const data = configurationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const names = new Set<string>();

  for (const project of data.projects) {
    if (names.has(project.name)) throw new Error("Duplicate remote SSH project: " + project.name);

    if (project.root === "/" || project.root.split("/").includes("..")) {
      throw new Error("Remote SSH root must be a specific absolute project directory");
    }

    names.add(project.name);
  }

  return data.projects;
}

export class RemoteSshBridge {
  private readonly projects: SshProject[];
  private readonly sessions = new Map<string, RemoteSession>();
  constructor(configDir: string) { this.projects = loadRemoteSshProjects(configDir); }
  get enabled(): boolean { return this.projects.length > 0; }

  async open(name: string): Promise<{ workspace_id: string; result: string }> {
    const project = this.projects.find((entry) => entry.name === name);

    if (!project) {
      throw new Error("Remote project is not allowed. Available projects: " + this.projects.map((p) => p.name).join(", "));
    }

    const output = await this.run(project, { op: "open" }, 20000);
    const id = "rss_" + randomBytes(12).toString("hex");
    this.sessions.set(id, { ...project, id });

    return {
      workspace_id: id,
      result: output.result + "\nRemote SSH workspace ID: " + id +
        "\nUse remote_ssh_read, remote_ssh_edit, remote_ssh_write, remote_ssh_exec and remote_ssh_status with this ID. " +
        "Do not use local open_workspace or local read/write/edit/bash for these remote files. No SSHFS.",
    };
  }

  async operation(id: string, input: RemoteInput, timeoutMs = 45000): Promise<RemoteResult> {
    const session = this.sessions.get(id);

    if (!session) throw new Error("Unknown or expired remote workspace ID; call remote_ssh_open again.");

    return this.run(session, input, timeoutMs);
  }

  private async run(project: SshProject, input: RemoteInput, timeoutMs: number): Promise<RemoteResult> {
    const payload = Buffer.from(JSON.stringify({ root: project.root, ...input }), "utf8").toString("base64");
    const script = REMOTE_HELPER.replace("__PAYLOAD__", payload);
    const json = await runSsh(project.host, script, timeoutMs);
    const response = remoteResponseSchema.parse(JSON.parse(json));

    if (!response.ok || !response.data) throw new Error(response.error ?? "Remote SSH operation failed");

    return response.data;
  }
}

export function runSsh(host: string, script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "ConnectionAttempts=1",
      "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes",
      host, "python3", "-",
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let oversized = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > MAX_SSH_OUTPUT_BYTES) { oversized = true; child.kill(); }
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 32768) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);

      if (timedOut) return reject(new Error("Remote SSH timed out."));

      if (oversized) return reject(new Error("Remote SSH response exceeds 2 MiB."));

      if (code !== 0) return reject(new Error("Remote SSH failed: " + Buffer.concat(stderr).toString("utf8").slice(0, 500)));
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(script, "utf8");
  });
}

const pathSchema = z.string().min(1).max(1000);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = { result: z.string(), sha256: z.string().optional(), changed: z.boolean().optional(), exit_code: z.number().optional() };

function reply(data: RemoteResult) {
  const structuredContent = {
    result: data.result,
    sha256: data.sha256,
    changed: data.changed,
    exit_code: data.exit_code,
  };

  return {
    content: [{ type: "text" as const, text: data.result }],
    structuredContent,
  };
}

export function registerRemoteSshTools(server: McpRegistrationTarget, config: ServerConfig): void {
  let bridge = sessionsByConfigDir.get(config.configDir);

  if (!bridge) {
    bridge = new RemoteSshBridge(config.configDir);
    sessionsByConfigDir.set(config.configDir, bridge);
  }

  if (!bridge.enabled) return;
  const remote = bridge;

  server.registerTool("remote_ssh_open", {
    title: "Open remote SSH workspace",
    description: "Open a pre-approved SSH project using this computer's SSH key and alias. This is a fast, native SSH workspace, not a local path or SSHFS mount.",
    inputSchema: { name: z.string().min(1).describe("Approved project name from remote-ssh.json.") },
    outputSchema: { workspace_id: z.string(), result: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    const opened = await remote.open(name);

    return { content: [{ type: "text" as const, text: opened.result }], structuredContent: opened };
  });

  server.registerTool("remote_ssh_read", {
    title: "Read remote SSH file",
    description: "Read remote UTF-8 file contents over SSH; returns SHA-256 for optimistic concurrency in remote edits.",
    inputSchema: {
      workspace_id: z.string(),
      path: pathSchema.describe("Path relative to the approved remote project root."),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, ...input }) => reply(await remote.operation(workspace_id, { op: "read", ...input })));

  server.registerTool("remote_ssh_write", {
    title: "Write remote SSH file",
    description: "Atomically create or replace a remote UTF-8 file. Existing files require the expected SHA-256 returned by remote_ssh_read.",
    inputSchema: {
      workspace_id: z.string(),
      path: pathSchema,
      content: z.string().max(1024 * 1024),
      expected_sha256: hashSchema.optional(),
    },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ workspace_id, ...input }) => reply(await remote.operation(workspace_id, { op: "write", ...input })));

  server.registerTool("remote_ssh_edit", {
    title: "Edit remote SSH file",
    description: "Replace exact unique text blocks in remote file, with SHA-256 verification and atomic replacement.",
    inputSchema: {
      workspace_id: z.string(),
      path: pathSchema,
      expected_sha256: hashSchema,
      edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() })).min(1).max(20),
    },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ workspace_id, ...input }) => reply(await remote.operation(workspace_id, { op: "edit", ...input })));

  server.registerTool("remote_ssh_exec", {
    title: "Execute SSH command on remote project",
    description: "Execute a Bash command on the approved remote SSH host. Commands execute with the remote user's permissions; request confirmation for destructive commands.",
    inputSchema: {
      workspace_id: z.string(),
      command: z.string().min(1).max(5000),
      cwd: z.string().max(1000).optional(),
      timeout: z.number().int().min(1).max(120).optional(),
    },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspace_id, ...input }) => reply(await remote.operation(workspace_id, { op: "exec", ...input }, (input.timeout ?? 30) * 1000 + 12000)));

  server.registerTool("remote_ssh_status", {
    title: "Remote SSH Git status",
    description: "Get Git status from a configured remote SSH project in one round trip.",
    inputSchema: { workspace_id: z.string() },
    outputSchema: resultSchema,
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id }) => reply(await remote.operation(workspace_id, { op: "status" })));
}
