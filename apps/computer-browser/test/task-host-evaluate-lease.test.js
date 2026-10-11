"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskHost } = require("../main/harness/task-host");
const { EvaluateLeases } = require("../main/harness/evaluate-lease");

test("task host grants, audits and revokes evaluate leases", async () => {
  const leases = new EvaluateLeases();
  const host = new TaskHost({ storageRoot: fs.mkdtempSync(path.join(os.tmpdir(), "elease-")), evaluateLeases: leases, makeBrowser: () => ({}), makePlanner: () => ({}), hostVerifier: () => true, approve: async () => ({ decision: "allow", reasons: [] }) });
  await assert.rejects(host.grantEvaluateLease({ taskId: "t", origin: "https://a.test/path" }), { code: "invalid_lease" });
  await host.grantEvaluateLease({ taskId: "t", origin: "https://a.test", purpose: "read" });
  assert.equal(leases.authorize("t", "https://a.test").allowed, true);
  await host.revokeEvaluateLease({ taskId: "t", origin: "https://a.test" });
  assert.equal(leases.authorize("t", "https://a.test").allowed, false);
  assert.deepEqual((await host.getEvaluateAudit()).map((e) => e.type), ["grant", "use", "revoke", "denied"]);
});

test("task host lists and forgets saved logins per agent without exposing values", async () => {
  const { createSessionVault } = require("../main/harness/session-vault");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svault-"));
  const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
  const vault = createSessionVault({ dir, storage: { isEncryptionAvailable: () => true, encryptString: (t) => xor(Buffer.from(t)), decryptString: (d) => xor(d).toString() } });
  const host = new TaskHost({ storageRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sh-")), sessionVault: vault, makeBrowser: () => ({}), makePlanner: () => ({}), hostVerifier: () => true, approve: async () => ({ decision: "allow", reasons: [] }) });
  const agentId = "0123abcd-0123-4567-89ab-0123456789ab";
  await vault.save(`persist:halo-agent-${agentId}`, [{ name: "sid", value: "SECRET", domain: ".example.com", path: "/", expires: -1 }]);
  const sites = await host.listSessionSites({ agentId });
  assert.deepEqual(sites, [{ site: "example.com", cookieCount: 1 }]);
  await assert.rejects(host.listSessionSites({ agentId: "../x" }), { code: "invalid_agent" });
  assert.deepEqual(await host.forgetSessionSite({ agentId, site: "example.com" }), { forgotten: true });
  assert.deepEqual(await host.listSessionSites({ agentId }), []);
});
