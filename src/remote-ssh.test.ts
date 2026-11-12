import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { loadRemoteSshProjects, RemoteSshBridge } from "./remote-ssh.js";
import { createMcpServer } from "./server.js";
import { writeTestDevspaceConfig } from "./test-support/config.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("remote SSH config accepts only explicit project aliases and paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-ssh-config-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "remote-ssh.json");
  await writeFile(file, JSON.stringify({
    projects: [{ name: "test-project", host: "test-host", root: "/home/test/project" }],
  }));
  assert.deepEqual(loadRemoteSshProjects(dir), [
    { name: "test-project", host: "test-host", root: "/home/test/project" },
  ]);

  await writeFile(file, JSON.stringify({
    projects: [{ name: "test-project", host: "-oProxyCommand=whoami", root: "/home/test/project" }],
  }));
  assert.throws(() => loadRemoteSshProjects(dir));

  await writeFile(file, JSON.stringify({
    projects: [{ name: "test-project", host: "test-host", root: "/home/test/../project" }],
  }));
  assert.throws(() => loadRemoteSshProjects(dir), /specific absolute project/);

  await writeFile(file, JSON.stringify({
    projects: [
      { name: "dupe", host: "test-host", root: "/home/test/project" },
      { name: "dupe", host: "test-host", root: "/home/test/project" },
    ],
  }));
  assert.throws(() => loadRemoteSshProjects(dir), /Duplicate/);
});

test("an unconfigured DevSpace does not expose remote SSH projects", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "devspace-ssh-empty-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(loadRemoteSshProjects(dir), []);
  const bridge = new RemoteSshBridge(dir);
  assert.equal(bridge.enabled, false);
  await assert.rejects(() => bridge.open("anything"), /not allowed/);
});

test("Gemini-compatible MCP tools include remote SSH without changing the ChatGPT tool list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-ssh-surface-"));
  const configDir = join(root, ".config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "remote-ssh.json"), JSON.stringify({
    projects: [{ name: "example", host: "test-host", root: "/home/test/project" }],
  }));

  const config = loadConfig(writeTestDevspaceConfig(configDir, {
    storage: { stateDir: join(root, ".state") },
    workspaces: { allowedRoots: [root] },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));

  const store = new SqliteWorkspaceStore(config.stateDir);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const listFor = async (surface: "claude" | "codex") => {
    const server = createMcpServer(
      config, surface, new WorkspaceRegistry(config, store),
      createReviewCheckpointManager(), new ProcessSessionManager(),
      () => [], [],
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-gemini-web-host", version: "1.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.listTools();

      return result.tools.map((tool) => tool.name);
    } finally {
      await client.close();
      await server.close();
    }
  };

  const gemini = await listFor("claude");
  assert.ok(gemini.includes("remote_ssh_open"));
  assert.ok(gemini.includes("remote_ssh_read"));
  assert.ok(gemini.includes("remote_ssh_edit"));
  assert.ok(gemini.includes("remote_ssh_exec"));
  assert.ok(gemini.includes("bash"));

  const chatgpt = await listFor("codex");
  assert.ok(chatgpt.includes("apply_patch"));
  assert.ok(chatgpt.includes("exec_command"));
  assert.ok(!chatgpt.some((name) => name.startsWith("remote_ssh_")));
});

test("SSH integration: open and read-only status without any mounts", {
  skip: process.env.DEVSPACE_REMOTE_SSH_INTEGRATION !== "1"
    || !process.env.DEVSPACE_REMOTE_SSH_TEST_PROJECT,
}, async () => {
  const configDir = join(homedir(), ".devspace");
  const bridge = new RemoteSshBridge(configDir);
  const started = performance.now();
  const opened = await bridge.open(process.env.DEVSPACE_REMOTE_SSH_TEST_PROJECT ?? "");
  const openMs = Math.round(performance.now() - started);
  assert.match(opened.workspace_id, /^rss_[0-9a-f]{24}$/);
  assert.match(opened.result, /Remote SSH project is accessible/);

  const statusStarted = performance.now();
  const status = await bridge.operation(opened.workspace_id, { op: "status" });
  const statusMs = Math.round(performance.now() - statusStarted);
  assert.equal(status.exit_code, 0);
  assert.match(status.result, /## /);
  process.stdout.write("REMOTE_SSH_BENCH open=" + openMs + "ms status=" + statusMs + "ms\n");

  const read = await bridge.operation(opened.workspace_id, {
    op: "read",
    path: process.env.DEVSPACE_REMOTE_SSH_TEST_FILE ?? "README.md",
    offset: 1,
    limit: 5,
  });

  assert.match(read.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(read.result.length > 0);

  const command = await bridge.operation(opened.workspace_id, {
    op: "exec",
    command: "pwd",
    timeout: 10,
  });

  assert.equal(command.exit_code, 0);
  assert.match(command.result, /^\//);

  await assert.rejects(
    () => bridge.operation(opened.workspace_id, { op: "read", path: "../../etc/passwd" }),
    /Path traversal/,
  );
});
