import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRemoteSshProjects, RemoteSshBridge } from "./remote-ssh.js";

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
