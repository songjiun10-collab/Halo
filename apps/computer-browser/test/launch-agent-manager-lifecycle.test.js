"use strict";

// Background-runtime plan Task 5 step 6: install/start/stop/update/remove
// operations layered on top of launch-agent-manager.js's pure
// resolveBackgroundServiceInvocation() (covered separately by
// test/background-runtime-launchagent.test.js, which this file never
// touches). Every filesystem and launchctl touchpoint here is injected --
// a temporary directory stands in for ~/Library/LaunchAgents and a fake
// recording function stands in for the real launchctl binary, so this suite
// never installs, starts, or removes anything from a real user's actual
// LaunchAgents directory or launchd domain.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  LaunchAgentManager,
  LaunchAgentError,
  generatePlist,
} = require("../main/harness/launch-agent-manager");

const EXECUTABLE_PATH = path.join(path.sep, "Applications", "Halo.app", "Contents", "MacOS", "Halo");
const LABEL = "com.halo.computerbrowser.background.test-user";

async function mkTempLaunchAgentsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-launchagents-"));
}

function fakeLaunchctl(calls, { failOn } = {}) {
  return async (args) => {
    calls.push(args);
    if (failOn && failOn(args)) {
      const error = new Error(`launchctl ${args.join(" ")} failed: service not found`);
      throw error;
    }
    return "";
  };
}

// ---- generatePlist: pure XML builder ----

test("generatePlist produces ProgramArguments as an array (executable + args), never a joined shell string", () => {
  const xml = generatePlist({
    label: LABEL,
    executablePath: EXECUTABLE_PATH,
    arguments: ["--halo-background-service"],
  });
  assert.match(xml, /<key>Label<\/key><string>com\.halo\.computerbrowser\.background\.test-user<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>/);
  assert.match(xml, new RegExp(`<string>${EXECUTABLE_PATH.replace(/[/\\]/g, "\\$&")}</string>`));
  assert.match(xml, /<string>--halo-background-service<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
});

test("generatePlist escapes XML-significant characters in the label and arguments", () => {
  const xml = generatePlist({
    label: LABEL,
    executablePath: EXECUTABLE_PATH,
    arguments: ["--flag=<value>&\"quoted\""],
  });
  assert.ok(!xml.includes("<value>"), "raw angle brackets from argument content must be escaped");
  assert.match(xml, /--flag=&lt;value&gt;&amp;/);
});

test("generatePlist includes StandardOutPath/StandardErrorPath only when provided", () => {
  const withLogs = generatePlist({
    label: LABEL,
    executablePath: EXECUTABLE_PATH,
    arguments: [],
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/err.log",
  });
  assert.match(withLogs, /<key>StandardOutPath<\/key><string>\/tmp\/out\.log<\/string>/);
  assert.match(withLogs, /<key>StandardErrorPath<\/key><string>\/tmp\/err\.log<\/string>/);

  const withoutLogs = generatePlist({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: [] });
  assert.ok(!withoutLogs.includes("StandardOutPath"));
  assert.ok(!withoutLogs.includes("StandardErrorPath"));
});

test("generatePlist rejects a relative executablePath and a non-array arguments field", () => {
  assert.throws(
    () => generatePlist({ label: LABEL, executablePath: "Halo", arguments: [] }),
    LaunchAgentError,
  );
  assert.throws(
    () => generatePlist({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: "--flag" }),
    LaunchAgentError,
  );
});

test("generatePlist rejects a missing or empty label", () => {
  assert.throws(
    () => generatePlist({ label: "", executablePath: EXECUTABLE_PATH, arguments: [] }),
    LaunchAgentError,
  );
});

// ---- LaunchAgentManager: install/start/stop/update/remove ----

test("install() writes a private (0600) plist file under the injected LaunchAgents directory, creating it if missing", async () => {
  const root = await mkTempLaunchAgentsDir();
  const launchAgentsDir = path.join(root, "nested", "LaunchAgents");
  const manager = new LaunchAgentManager({ launchAgentsDir, runLaunchctl: fakeLaunchctl([]), uid: 501 });
  const { plistPath } = await manager.install({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: ["--halo-background-service"] });
  assert.equal(plistPath, path.join(launchAgentsDir, `${LABEL}.plist`));
  const stat = await fs.stat(plistPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const content = await fs.readFile(plistPath, "utf8");
  assert.match(content, /<key>Label<\/key><string>com\.halo\.computerbrowser\.background\.test-user<\/string>/);
});

test("install() refuses to write through a symlinked plist path", async () => {
  const root = await mkTempLaunchAgentsDir();
  const decoyTarget = path.join(root, "decoy.plist");
  await fs.writeFile(decoyTarget, "not a real plist");
  const launchAgentsDir = path.join(root, "LaunchAgents");
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.symlink(decoyTarget, path.join(launchAgentsDir, `${LABEL}.plist`));
  const manager = new LaunchAgentManager({ launchAgentsDir, runLaunchctl: fakeLaunchctl([]), uid: 501 });
  await assert.rejects(
    () => manager.install({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: [] }),
    (error) => {
      assert.ok(error instanceof LaunchAgentError);
      assert.equal(error.code, "symlink_rejected");
      return true;
    },
  );
  assert.equal(await fs.readFile(decoyTarget, "utf8"), "not a real plist");
});

test("start() bootstraps the plist into the caller's gui/<uid> launchd domain", async () => {
  const root = await mkTempLaunchAgentsDir();
  const calls = [];
  const manager = new LaunchAgentManager({ launchAgentsDir: root, runLaunchctl: fakeLaunchctl(calls), uid: 501 });
  await manager.install({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: [] });
  const { serviceTarget } = await manager.start({ label: LABEL });
  assert.equal(serviceTarget, `gui/501/${LABEL}`);
  assert.deepEqual(calls, [["bootstrap", "gui/501", path.join(root, `${LABEL}.plist`)]]);
});

test("stop() boots the job out of launchd by its full service target, never just killing a pid", async () => {
  const root = await mkTempLaunchAgentsDir();
  const calls = [];
  const manager = new LaunchAgentManager({ launchAgentsDir: root, runLaunchctl: fakeLaunchctl(calls), uid: 501 });
  await manager.stop({ label: LABEL });
  assert.deepEqual(calls, [["bootout", `gui/501/${LABEL}`]]);
});

test("update() stops the old job, rewrites the plist, then starts it again -- in that order", async () => {
  const root = await mkTempLaunchAgentsDir();
  const calls = [];
  const manager = new LaunchAgentManager({ launchAgentsDir: root, runLaunchctl: fakeLaunchctl(calls), uid: 501 });
  await manager.install({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: ["--halo-background-service"] });
  await manager.start({ label: LABEL });
  calls.length = 0;

  await manager.update({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: ["--halo-background-service", "--updated"] });
  assert.deepEqual(calls, [["bootout", `gui/501/${LABEL}`], ["bootstrap", "gui/501", path.join(root, `${LABEL}.plist`)]]);
  const content = await fs.readFile(path.join(root, `${LABEL}.plist`), "utf8");
  assert.match(content, /--updated/);
});

test("update() tolerates the job not being loaded yet (first-time install via update)", async () => {
  const root = await mkTempLaunchAgentsDir();
  const calls = [];
  const manager = new LaunchAgentManager({
    launchAgentsDir: root,
    runLaunchctl: fakeLaunchctl(calls, { failOn: (args) => args[0] === "bootout" }),
    uid: 501,
  });
  await manager.update({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: [] });
  assert.deepEqual(calls.map((c) => c[0]), ["bootout", "bootstrap"]);
  await fs.stat(path.join(root, `${LABEL}.plist`));
});

test("remove() stops the job (best-effort) and deletes the plist file", async () => {
  const root = await mkTempLaunchAgentsDir();
  const calls = [];
  const manager = new LaunchAgentManager({ launchAgentsDir: root, runLaunchctl: fakeLaunchctl(calls), uid: 501 });
  await manager.install({ label: LABEL, executablePath: EXECUTABLE_PATH, arguments: [] });
  calls.length = 0;

  const { plistPath } = await manager.remove({ label: LABEL });
  assert.deepEqual(calls, [["bootout", `gui/501/${LABEL}`]]);
  await assert.rejects(fs.stat(plistPath), (error) => error.code === "ENOENT");
});

test("remove() tolerates the job not being loaded and the plist already being absent", async () => {
  const root = await mkTempLaunchAgentsDir();
  const manager = new LaunchAgentManager({
    launchAgentsDir: root,
    runLaunchctl: fakeLaunchctl([], { failOn: () => true }),
    uid: 501,
  });
  await manager.remove({ label: LABEL });
});

test("remove() refuses to delete through a symlinked plist path", async () => {
  const root = await mkTempLaunchAgentsDir();
  const decoyTarget = path.join(root, "decoy.plist");
  await fs.writeFile(decoyTarget, "keep me");
  await fs.symlink(decoyTarget, path.join(root, `${LABEL}.plist`));
  const manager = new LaunchAgentManager({
    launchAgentsDir: root,
    runLaunchctl: fakeLaunchctl([], { failOn: () => true }),
    uid: 501,
  });
  await assert.rejects(
    () => manager.remove({ label: LABEL }),
    (error) => {
      assert.ok(error instanceof LaunchAgentError);
      assert.equal(error.code, "symlink_rejected");
      return true;
    },
  );
  assert.equal(await fs.readFile(decoyTarget, "utf8"), "keep me");
});

test("LaunchAgentManager requires an explicit or process-derived POSIX uid", () => {
  const root = os.tmpdir();
  assert.throws(
    () => new LaunchAgentManager({ launchAgentsDir: root, runLaunchctl: fakeLaunchctl([]), uid: null }),
    LaunchAgentError,
  );
});
