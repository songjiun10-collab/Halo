"use strict";

const { app, BrowserWindow, WebContentsView, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { ControlApi } = require("./control-api");
const registerIpc = require("./ipc");
const layoutConstants = require("../shared/layout-constants");
const { requestDecision } = require("./approver-client");
const { TaskHost } = require("./harness/task-host");
const { UsageLedger } = require("./harness/usage-ledger");
const { BrowserAdapter } = require("./harness/browser-adapter");
const { BrowserSurfaces } = require("./harness/browser-surfaces");
const { PlannerStdioAdapter } = require("./harness/planner-stdio");
const { CodexMcpAdapter, parseRepositories } = require("./harness/providers/codex-mcp-adapter");
const { makeMcpBrowserObservation } = require("./harness/mcp-browser-observation");
const { CodexMcpProvider } = require("./harness/providers/codex-mcp-provider");
const { GenericMcpBroker } = require("./harness/generic-mcp-broker");
const { SharedMcpProvider } = require("./harness/shared-mcp-provider");
const { McpCatalogCache } = require("./harness/mcp-catalog-cache");
const { validateMcpArguments } = require("./harness/mcp-schema-validator");
const { MemoryMonitor } = require("./harness/memory-monitor");
const { AgentViewportHost, makeDualSurfaceBrowser } = require("./harness/agent-viewport-host");
const { resolvePlannerCommand } = require("./harness/planner-command");
const { parseOperatorOverride, selectPlannerLaunch } = require("./harness/planner-providers");
const { HostSettingsStore } = require("./harness/host-settings");
const { LocalMemoryStore } = require("./harness/local-memory-store");
const { LocalCredentialVault } = require("./harness/local-credential-vault");
const { SessionVault } = require("./harness/profile-import/session-vault");
const { ProfileImporter, SessionConfigStore } = require("./harness/profile-import/profile-importer");
const { readChromeCookies } = require("./harness/profile-import/chrome-cookie-reader");
const { readChromeSettings } = require("./harness/profile-import/chrome-settings-reader");
const { sumProcessTreeRssBytes } = require("./harness/process-tree-memory");
const { BackgroundRuntimeService } = require("./harness/background-runtime-service");
const { BackgroundRuntimeClient } = require("./harness/background-runtime-client");
const { prepareSocketDir } = require("./harness/background-runtime-ipc");
const { launchAgentUserId, createBackgroundLaunchAgent } = require("./harness/background-launch-agent");

// Real OS-level process-tree RSS lookup for workers Electron does not track
// (the Python approver and local planner worker, including its CLI child).
// Query the full process table and sum each registered root plus descendants;
// `ps` reports RSS in KB on macOS/Linux. Missing roots and ps failures return
// null, so unmeasurable workers fail closed for parallel admission.
function getExternalMemoryBytesViaPs(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,rss="], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(sumProcessTreeRssBytes(stdout, pid));
    });
  });
}

// The single source of truth for these values. The main process is not
// sandboxed, so it can require the shared module directly; preload cannot
// (see preload/index.js) and receives this same object serialized through
// additionalArguments instead -- one source, two consumers, no drift.
const RENDERER_LAYOUT = Object.freeze({
  headerHeight: layoutConstants.HEADER_HEIGHT,
  footerHeight: layoutConstants.FOOTER_HEIGHT,
  sidePanelWidth: layoutConstants.SIDE_PANEL_WIDTH,
  mobileBreakpoint: layoutConstants.MOBILE_BREAKPOINT,
});

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APPROVER_SCRIPT = path.join(REPO_ROOT, "apps", "computer-browser", "approver", "approver_service.py");
const SERVICE_MODE = process.argv.includes("--halo-background-service");
const RUNTIME_DIR_NAME = "background-runtime";
const CAPABILITY_FILE_NAME = "capability";

let approverProcess = null;
let socketDir = null;
let memoryPollTimer = null;
let runtimeService = null;
let runtimeClient = null;
const runtimeClients = new Set();
let runtimeContainer = null;
let runtimeCapability = null;
let runtimeCapabilityPath = null;
let quitDecisionPending = false;
const taskHosts = new Set();
const closingTaskHosts = [];
let shutdownStarted = false;

// Single MemoryMonitor for the whole app (design doc section 10, user
// mandate: sum every process HALO's computer-browser actually launches --
// Electron main/renderer/GPU/utility plus the Python approver and any local
// planner worker -- and never satisfy the <1GB budget by measuring V8 heap
// alone or excluding worker processes). Polled on an interval below rather
// than sampled fresh on every getPressureLevel() call, so a per-dispatch
// check in task-controller.js's hot loop never itself does a synchronous OS
// query.
const memoryMonitor = new MemoryMonitor({
  getAppMetrics: () => app.getAppMetrics(),
  getExternalMemoryBytes: getExternalMemoryBytesViaPs,
});

// Trusted launch scope only. An empty scope keeps MCP entirely dormant.
// One app-wide transport is counted with its descendants in the RSS budget.
const codexMcpRepositories = parseRepositories(process.env.HALO_CODEX_MCP_REPOSITORIES || "");
const codexMcp = codexMcpRepositories.length ? new CodexMcpAdapter({
  repositories: codexMcpRepositories,
  cwd: REPO_ROOT,
  canRun: () => memoryMonitor.getPressureLevel() === "normal",
  onWorkerStart: (identity) => memoryMonitor.registerExternalProcess(identity),
  onWorkerExit: ({ pid, creationTime }) => memoryMonitor.unregister(pid, creationTime),
}) : null;

// Routed MCP tool sharing (docs/superpowers/specs/2026-10-01-routed-mcp-tool-
// sharing-design.md). Off unless the task was attached with "codex" pinned in
// mcpProviders. One app-wide Codex app-server, counted in the RSS budget, is
// prepared lazily on first use and shared by every task through its own
// lease, so a broker closing never stops another task's provider.
let sharedCodexMcp = null;
function makeHarnessMcpBroker(_taskId, hooks, { mcpProviders = [] } = {}) {
  if (!Array.isArray(mcpProviders) || !mcpProviders.includes("codex")) return null;
  const canRun = () => memoryMonitor.getPressureLevel() === "normal";
  sharedCodexMcp ||= new SharedMcpProvider({
    provider: new CodexMcpProvider({
      cwd: REPO_ROOT,
      canRun,
      onWorkerStart: (identity) => memoryMonitor.registerExternalProcess(identity),
      onWorkerExit: ({ pid, creationTime }) => memoryMonitor.unregister(pid, creationTime),
    }),
    cache: new McpCatalogCache(),
    canRun,
  });
  return new GenericMcpBroker({
    providers: [sharedCodexMcp.lease()],
    validateArguments: (schema, args) => validateMcpArguments(schema, args),
    ...hooks,
  });
}

function withConnectorObservation(browser) {
  return codexMcp ? makeMcpBrowserObservation({
    browser, connector: codexMcp,
    onMetric: (metric) => console.info("[mcp-observation]", JSON.stringify(metric)),
  }) : browser;
}

// Single app-wide registry of hidden per-task agent viewports (P0 agent
// viewport/background isolation -- see main/harness/agent-viewport-host.js
// for the full contract and its scope note). Module-level like
// memoryMonitor: it outlives any single visible BrowserWindow, and every
// task's hidden view is disposed via its own browser.dispose() call (see
// makeHarnessBrowser below), not tied to the visible window's lifecycle.
const agentViewportHost = new AgentViewportHost();

function makeSocketDir() {
  // 0700, owned by this process's uid -- the same contract
  // experiments/e007_dual_agent_provenance_gate/channel.py's
  // UnixSocketChannel enforces on the Python side. realpathSync is required
  // here: macOS's os.tmpdir() resolves under /var, which is itself a symlink
  // to /private/var, and UnixSocketChannel walks every path component from
  // root rejecting any symlink -- an unresolved path makes the approver's
  // listen() fail (silently retried in its loop) forever, and the socket
  // file never gets created. Confirmed by actually running the app: the
  // executor saw a permanent ENOENT until this fix.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "halo-browser-approver-")));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// "Start at login" for the background service (macOS LaunchAgent). The
// windows only offer it; nothing is installed until the user turns it on.
let backgroundLaunchAgent;
function getBackgroundLaunchAgent() {
  if (backgroundLaunchAgent !== undefined) return backgroundLaunchAgent;
  backgroundLaunchAgent = null;
  if (process.platform !== "darwin" || SERVICE_MODE) return backgroundLaunchAgent;
  try {
    backgroundLaunchAgent = createBackgroundLaunchAgent({
      executablePath: process.execPath,
      appPath: app.isPackaged ? null : app.getAppPath(),
      userId: launchAgentUserId({ username: os.userInfo().username, uid: process.getuid?.() }),
      logPath: path.join(runtimePaths().dir, "launch-agent.log"),
    });
  } catch (error) {
    console.error("[harness] start at login is unavailable:", error);
  }
  return backgroundLaunchAgent;
}

function runtimePaths() {
  const dir = path.join(app.getPath("userData"), RUNTIME_DIR_NAME);
  return {
    dir,
    socketPath: path.join(dir, "ipc", "runtime.sock"),
    capabilityPath: path.join(dir, CAPABILITY_FILE_NAME),
  };
}

function assertPrivateCapabilityFile(capabilityPath) {
  const stat = fs.lstatSync(capabilityPath);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0 || stat.size !== 64) {
    throw new Error("background runtime capability file is not a private regular file");
  }
}

async function readRuntimeCapability(paths) {
  // The service owns this 0700 directory. A missing directory/file means
  // background mode was never configured; a malformed existing file is an
  // error, never a reason to trust an unverified endpoint.
  let dirStat;
  try {
    dirStat = fs.lstatSync(paths.dir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() ||
      (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) ||
      (dirStat.mode & 0o077) !== 0) {
    throw new Error("background runtime directory is not private");
  }
  try {
    assertPrivateCapabilityFile(paths.capabilityPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      // The service creates this directory before binding its socket and
      // publishing the capability. Treat even an empty prepared directory
      // as an in-progress/unavailable service, never as permission for a
      // second local writer of the same task journals.
      throw new Error("background runtime directory exists without a ready capability");
    }
    throw error;
  }
  const fd = fs.openSync(paths.capabilityPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== 64 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("background runtime capability file changed during read");
    }
    const capability = fs.readFileSync(fd, "utf8");
    if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error("background runtime capability is invalid");
    return capability;
  } finally {
    fs.closeSync(fd);
  }
}

async function publishRuntimeCapability(paths, capability) {
  if (!/^[0-9a-f]{64}$/.test(capability)) throw new Error("background runtime returned an invalid capability");
  try {
    assertPrivateCapabilityFile(paths.capabilityPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(paths.dir, `capability.${process.pid}.${crypto.randomBytes(8).toString("hex")}`);
  const fd = fs.openSync(temporaryPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(fd, capability, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporaryPath, paths.capabilityPath);
  } catch (error) {
    fs.unlinkSync(temporaryPath);
    throw error;
  }
  runtimeCapability = capability;
  runtimeCapabilityPath = paths.capabilityPath;
}

function removeOwnRuntimeCapability() {
  if (!runtimeCapability || !runtimeCapabilityPath) return;
  try {
    const paths = runtimePaths();
    if (fs.lstatSync(paths.dir).isDirectory() &&
        fs.lstatSync(runtimeCapabilityPath).isFile() &&
        fs.readFileSync(runtimeCapabilityPath, "utf8") === runtimeCapability) {
      fs.unlinkSync(runtimeCapabilityPath);
    }
  } catch {
    // A newer service or a changed path must not be removed by this one.
  }
}

function spawnApprover(socketPath) {
  const python = process.env.HALO_PYTHON || "python3";
  const child = spawn(python, [APPROVER_SCRIPT, "--socket", socketPath], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[approver] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[approver] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.error(`[approver] exited unexpectedly (code=${code}, signal=${signal})`);
    memoryMonitor.unregister(child.pid);
  });
  // Node's child_process doesn't expose the OS's own process-creation
  // timestamp; Date.now() at spawn time is used as the creationTime half of
  // MemoryMonitor's (pid, creationTime) dedup key instead. This is an
  // approximation (not the kernel's actual start time), disclosed here
  // rather than silently treated as exact -- it is precise enough to tell
  // this specific spawn apart from a later, different process that happens
  // to reuse the same pid, which is the only thing the dedup key needs.
  memoryMonitor.registerExternalProcess({ pid: child.pid, creationTime: Date.now(), label: "approver" });
  return child;
}

// Default hostVerifier for "host"-kind criteria (progress.js's
// verifyCriterion): "host_check" evidence, which browser-adapter.js only
// ever produces when a real navigate()/follow_link() genuinely succeeded,
// IS the host's own direct confirmation that A navigation happened -- but
// not, by itself, confirmation that THIS SPECIFIC criterion was satisfied.
// task-controller.js's _afterActionDispatched() attaches one action's
// evidenceCandidate to every criterionId the planner lists in
// proposal.criterionIds, so accepting any host_check unconditionally let a
// planner satisfy every host-verified criterion in the goal from a single
// arbitrary navigation. The criterion schema has no structured expected-URL
// field (criterion.text is free-form natural language), so the only
// non-semantic, mechanical check available without inventing page-content
// understanding is: does the criterion's own text actually name the host
// this navigation reached? That closes the arbitrary-navigation exploit
// while staying honest about not understanding page content -- a criterion
// whose text does not mention any host stays "pending" (evaluates to
// undefined) exactly like "artifact" evidence does, rather than being
// silently auto-verified or auto-rejected. A "user"-verification criterion
// never reaches this callback at all (progress.js handles that kind itself).
function defaultHostVerifier(criterion, evidence) {
  if (evidence.kind !== "host_check" || typeof evidence.sourceUrl !== "string") return undefined;
  let hostname;
  try {
    hostname = new URL(evidence.sourceUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!hostname || typeof criterion.text !== "string") return undefined;
  return criterion.text.toLowerCase().includes(hostname) ? true : undefined;
}

// Builds the real approve() TaskController dependency: routes a harness
// task's gated-action descriptor through the same approver-client.js/
// approver_service.py boundary control-api.js's legacy path uses, so both
// paths are judged by the identical independent ALLOW/REVIEW/DENY decision.
function makeHarnessApprove(socketPath) {
  return (taskId, descriptor) =>
    requestDecision(socketPath, {
      request_id: descriptor.requestId,
      action: descriptor.action,
      origin: descriptor.origin || "",
      summary: descriptor.summary,
      self_provenance: descriptor.selfProvenance,
      source: descriptor.source,
      target_scope: descriptor.targetScope ?? null,
      contains_secret: Boolean(descriptor.containsSecret),
    });
}

// Each harness task owns TWO surfaces now, not one:
//   - a VISIBLE page (unchanged from before): laid out beneath the React
//     chrome, BrowserSurfaces hides it for renderer overlays, and it is what
//     taskBrowserAction/getTaskBrowser/setTaskViewport (the existing,
//     already-shipped renderer contract) operate on -- exactly as before
//     this change, byte-for-byte.
//   - a hidden, fixed-1440x900 agent view (main/harness/agent-viewport-host.js)
//     that is the REAL target of the task's autonomous observe()/execute()
//     calls. This is the P0 agent-viewport/background-isolation requirement:
//     autonomous execution actually happens against a fixed, isolated,
//     off-screen view, not the user's responsive visible page.
// makeDualSurfaceBrowser composes both into the single `browser` object
// task-controller.js/task-host.js already expect, with no changes to either
// file -- see agent-viewport-host.js's own doc comment for the exact routing
// contract and why it is fail-closed for user actions by construction.
function makeHarnessBrowser(surfaces, agentViewportHost) {
  return (taskId) => {
    const view = new WebContentsView({ webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `halo-task-${taskId}`,
    } });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    surfaces.register(taskId, view);
    const visibleAdapter = new BrowserAdapter({ view });
    // Same session partition as the visible view above (`halo-task-${taskId}`)
    // -- design doc's session/cookie boundary section: the agent view must
    // share the task's existing login/cookie state, not start a fresh one.
    const agentAdapter = withConnectorObservation(agentViewportHost.ensure(taskId));
    return makeDualSurfaceBrowser({
      agentAdapter,
      visibleAdapter,
      disposeAgent: async () => {
        try { if (codexMcp) await agentAdapter.dispose?.(); }
        finally { await agentViewportHost.dispose(taskId); }
      },
    });
  };
}

function makeChildHarnessBrowser(parentTaskId, childId, origin) {
  const adapter = withConnectorObservation(agentViewportHost.ensureChild(parentTaskId, childId, { assignedOrigin: origin }));
  // ChildAgentCoordinator disposes the browser it received. A bare adapter
  // would destroy the WebContents but leave AgentViewportHost's hidden
  // BrowserWindow and childId registry alive across completed children.
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "dispose") return async () => {
        try { if (codexMcp) await adapter.dispose?.(); }
        finally { await agentViewportHost.disposeChild(childId); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Planner worker command comes ONLY from trusted host config (env vars set
// by whoever launches this Electron app, or a real `node` binary this host
// discovers on its own PATH -- see harness/planner-command.js) -- never from
// the UI, a page, or the model itself (design doc section 6). With nothing
// configured and no real node found, the adapter stays honestly
// "unavailable" (PlannerStdioAdapter throws
// PlannerTransportError("planner_unavailable", ...) from next()) rather
// than fabricating a natural-language-sounding proposal; task-controller.js
// surfaces that as paused:planner_unavailable.
//
// Resolved ONCE here, not inside the returned per-task factory below:
// resolution may itself spawn a short-lived `node --version` verification
// process (harness/planner-command.js), and redoing that on every task/
// context-reset would add back exactly the kind of per-task process-spawn
// overhead this exists to reduce.
//
// Which worker runs is decided per planner (docs/superpowers/specs/
// 2026-10-01-planner-router-design.md): an operator HALO_PLANNER_* override
// always wins; otherwise the task's pinned settings plannerProvider selects a
// host-allowlisted worker; "none" keeps the planner honestly unavailable.
function makeHarnessPlanner(usageLedger) {
  const { command: plannerCommand, env: plannerEnv } = resolvePlannerCommand();
  const override = parseOperatorOverride(process.env, plannerCommand);
  if (override && !override.configured) {
    console.error("[harness] HALO_PLANNER_ARGS must be a non-empty JSON array of worker arguments");
  }
  return (taskId, { role = "parent", plannerProvider = "none", plannerModel, plannerFast = false } = {}) => {
    const launch = selectPlannerLaunch({ override, providerId: plannerProvider, model: plannerModel, fast: plannerFast, nodeCommand: plannerCommand });
    return new PlannerStdioAdapter({
      // A Node executable on PATH alone is not a configured agent worker.
      command: launch.command,
      args: launch.args,
      cwd: REPO_ROOT,
      env: plannerEnv,
      role,
      onUsage: (usage) => {
        // A settings-selected worker may only report usage for its own provider.
        if (launch.usageProvider && usage.provider !== launch.usageProvider) return;
        usageLedger.record(taskId, usage.provider, usage);
      },
      // Host-owned hooks so every planner worker this app ever spawns is
      // counted in the same <1GB aggregate memory budget the Python
      // approver already is (see the memoryMonitor comment above) --
      // consumed by planner-stdio.js's own spawn/exit handling.
      onWorkerStart: ({ pid, creationTime }) => memoryMonitor.registerExternalProcess({ pid, creationTime, label: "planner" }),
      onWorkerExit: ({ pid, creationTime }) => memoryMonitor.unregister(pid, creationTime),
    });
  };
}

async function createHarnessHost(socketPath, hostWindow) {
  const dataRoot = path.join(app.getPath("userData"), "harness-data");
  const settingsStore = new HostSettingsStore({ storageRoot: dataRoot });
  const settings = await settingsStore.load();
  const memoryStore = new LocalMemoryStore({ storageRoot: dataRoot, safeStorage: require("electron").safeStorage });
  const credentialVault = new LocalCredentialVault({ storageRoot: dataRoot, safeStorage: require("electron").safeStorage });
  const profileImporter = new ProfileImporter({
    vault: new SessionVault({ storageRoot: dataRoot, safeStorage: require("electron").safeStorage }),
    config: new SessionConfigStore({ storageRoot: dataRoot }),
    readers: { chrome: ({ domains, profile }) => readChromeCookies({ domains, profile }) },
    settingsReaders: { chrome: ({ profile }) => readChromeSettings({ profile }) },
  });
  const usageLedger = await new UsageLedger({ storageRoot: dataRoot }).load();
  let taskHost;
  const surfaces = new BrowserSurfaces(hostWindow, { isUserControlled: (taskId) => taskHost.canUseTaskBrowser(taskId) });
  taskHost = new TaskHost({
    storageRoot: path.join(app.getPath("userData"), "harness-tasks"),
    makeBrowser: makeHarnessBrowser(surfaces, agentViewportHost),
    makeChildBrowser: makeChildHarnessBrowser,
    setViewport: (taskId, bounds) => surfaces.setViewport(taskId, bounds),
    makePlanner: makeHarnessPlanner(usageLedger),
    usageLedger,
    usageSources: {
      claude: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"),
      codex: path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions"),
    },
    hostVerifier: defaultHostVerifier,
    approve: makeHarnessApprove(socketPath),
    memoryMonitor,
    memoryStore,
    permissionMode: settings.permissionMode,
    plannerEffort: settings.plannerEffort,
    plannerEffortMode: settings.plannerEffortMode,
    plannerProvider: settings.plannerProvider,
    plannerModel: settings.plannerModel,
    plannerFast: settings.plannerFast,
    mcpProviders: settings.mcpProviders,
    makeMcpBroker: makeHarnessMcpBroker,
    executionMode: settings.executionMode,
    settingsStore,
    credentialVault,
    profileImporter,
    // Same non-persistent partition the task's views use, so cookies injected
    // here are what the first navigation sends.
    getTaskSession: (taskId) => require("electron").session.fromPartition(`halo-task-${taskId}`),
  });
  taskHosts.add(taskHost);
  return taskHost;
}

async function createWindow(socketPath, attachedClient = undefined) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--halo-layout=${JSON.stringify(RENDERER_LAYOUT)}`],
    },
  });

  const controlApi = new ControlApi({ window: win, socketPath });
  let taskHost;
  try {
    taskHost = attachedClient === undefined ? await createHarnessHost(socketPath, win) : attachedClient;
  } catch (error) {
    // Do not leave an empty BrowserWindow behind when its per-window host
    // could not be constructed (e.g. a failed runtime attach).
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  win.once("closed", () => {
    if (attachedClient) {
      runtimeClients.delete(attachedClient);
      if (runtimeClient === attachedClient) runtimeClient = runtimeClients.values().next().value ?? null;
    }
    const closing = (attachedClient ? attachedClient.detach() : taskHost?.close())?.catch((error) => {
      console.error("[harness] failed to detach or close task resources:", error);
    }).finally(() => { if (attachedClient === undefined) taskHosts.delete(taskHost); });
    if (!closing) return;
    closingTaskHosts.push(closing);
  });
  registerIpc(win, controlApi, {
    taskHost,
    launchAgent: getBackgroundLaunchAgent() ?? undefined,
    onNewWindow: async () => {
      const client = await connectRuntimeClient();
      // Without the shared background runtime a new window would build a second
      // local TaskHost over the same task, queue and roster storage, with its own
      // active-task map and write chains. Refuse rather than let two hosts race.
      if (client === undefined) {
        throw Object.assign(new Error("a new window needs the background runtime; this window already owns the local task host"), { code: "runtime_required" });
      }
      await createWindow(socketPath, client);
      return { opened: true };
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  return win;
}

async function connectRuntimeClient() {
  const paths = runtimePaths();
  let capability;
  try {
    capability = await readRuntimeCapability(paths);
  } catch (error) {
    console.error("[harness] background runtime credential is unavailable:", error);
    return null;
  }
  if (!capability) return undefined;
  const client = new BackgroundRuntimeClient({
    socketPath: paths.socketPath,
    capability,
    clientId: `ui-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  });
  try {
    await client.connect();
    runtimeClient = client;
    runtimeClients.add(client);
    return client;
  } catch (error) {
    console.error("[harness] background runtime is unavailable:", error);
    await client.detach().catch(() => {});
    return null;
  }
}

function startMemoryPolling() {
  // Keep the sample outside TaskController's dispatch hot path. In service
  // mode this process owns all task hosts; in local mode it owns the one UI
  // host; a UI attached to an external service has no local task host.
  memoryPollTimer = setInterval(() => {
    memoryMonitor.sample().then(() => Promise.allSettled([...taskHosts].map((host) => host.onMemorySample()))).catch(() => {
      // A transient measurement failure leaves the last sample in place.
    });
  }, 5000);
  memoryMonitor.sample().catch(() => {});
}

app.whenReady().then(async () => {
  socketDir = makeSocketDir();
  const socketPath = path.join(socketDir, "approver.sock");
  approverProcess = spawnApprover(socketPath);
  if (SERVICE_MODE) {
    app.dock?.hide();
    const paths = runtimePaths();
    await prepareSocketDir(paths.dir);
    runtimeContainer = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const taskHost = await createHarnessHost(socketPath, runtimeContainer);
    runtimeService = new BackgroundRuntimeService({ socketPath: paths.socketPath, socketRoot: paths.dir, taskHost });
    const { capability } = await runtimeService.start();
    // Always-on Agents run only here: per-window hosts share the same storage
    // and would each start the same occurrence.
    await taskHost.startAgentScheduler();
    await taskHost.startScheduler();
    runtimeService.onEvent((event) => {
      if (event === "serviceStopped") app.quit();
    });
    await publishRuntimeCapability(paths, capability);
  } else {
    await createWindow(socketPath, await connectRuntimeClient());
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        Promise.allSettled(closingTaskHosts.splice(0))
          .then(() => connectRuntimeClient())
          .then((client) => createWindow(socketPath, client))
          .catch((error) => console.error("[harness] failed to reopen the UI:", error));
      }
    });
  }
  startMemoryPolling();
}).catch((error) => {
  console.error("[harness] startup failed:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (!SERVICE_MODE && process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  if (quitDecisionPending) return;
  quitDecisionPending = true;
  (async () => {
    if (runtimeClients.size > 0 && !SERVICE_MODE) {
      const { response } = await dialog.showMessageBox({
        type: "question",
        title: "Halo background work",
        message: "What should happen to background tasks when Halo closes?",
        buttons: ["Continue in background", "Stop background service", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) {
        quitDecisionPending = false;
        return;
      }
      const clients = [...runtimeClients];
      if (response === 1) await clients[0]?.stopService("user_quit");
      await Promise.allSettled(clients.map((client) => client.detach()));
      runtimeClients.clear();
      runtimeClient = null;
    }
    shutdownStarted = true;
    if (memoryPollTimer) clearInterval(memoryPollTimer);
    if (runtimeService) await runtimeService.stopService("service_quit");
    const results = await Promise.allSettled([...taskHosts].map((host) => host.close()));
    for (const result of results) {
      if (result.status === "rejected") console.error("[harness] failed to close task resources:", result.reason);
    }
    await agentViewportHost.disposeAll();
    await codexMcp?.close();
    await sharedCodexMcp?.close();
    removeOwnRuntimeCapability();
    runtimeContainer?.destroy();
    if (approverProcess) approverProcess.kill();
    if (socketDir) {
      try {
        fs.rmSync(socketDir, { recursive: true, force: true });
      } catch {
        // A leftover empty approver temp dir is not a task-lifecycle event.
      }
    }
    app.quit();
  })().catch((error) => {
    quitDecisionPending = false;
    console.error("[harness] failed to complete Quit:", error);
  });
});
