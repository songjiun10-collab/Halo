// Memory/latency sampling for the Halo browser. Measures only the Chromium process tree that carries a given
// --user-data-dir marker (the model call is remote in a product, so planner processes are not part of it).
// macOS only: it uses `ps` for the tree and `footprint -j` for physical footprint (RSS double-counts shared pages).
const cp = require("node:child_process");
const fsp = require("node:fs/promises");
const nodeOs = require("node:os");
const nodePath = require("node:path");

type Proc = { pid: number; kind: string; rssKb: number; footprintBytes: number | null };
type TreeSample = { t: number; processes: Proc[]; totalFootprintBytes: number; totalRssKb: number; renderers: number; count: number };

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => cp.execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (_e: any, out: string) => resolve(String(out ?? ""))));
}

function kindOf(command: string): string {
  const m = /--type=([a-z-]+)/.exec(command);
  return m ? m[1] : "browser";
}

// marker: any substring unique to the run, normally the profile directory path.
async function sampleTree(marker: string, t = Date.now()): Promise<TreeSample> {
  const ps = await run("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="]);
  const rows: { pid: number; ppid: number; rssKb: number; command: string }[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), command: m[4] });
  }
  // Helper processes (renderer, gpu, ...) do not carry --user-data-dir, so take the marked root and all its descendants.
  const inTree = new Set(rows.filter((r) => r.command.includes(marker)).map((r) => r.pid));
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (!inTree.has(r.pid) && inTree.has(r.ppid)) { inTree.add(r.pid); grew = true; } }
  const found: Proc[] = rows.filter((r) => inTree.has(r.pid)).map((r) => ({ pid: r.pid, rssKb: r.rssKb, kind: kindOf(r.command), footprintBytes: null }));
  if (found.length > 0) {
    const out = nodePath.join(await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "halo-fp-")), "fp.json");
    await run("/usr/bin/footprint", [...found.flatMap((p) => ["-p", String(p.pid)]), "-j", out]);
    try {
      const parsed = JSON.parse(await fsp.readFile(out, "utf8"));
      for (const p of parsed.processes ?? []) { const hit = found.find((f) => f.pid === p.pid); if (hit) hit.footprintBytes = p.footprint ?? null; }
    } catch { /* footprint can lose a race with an exiting helper; RSS is still recorded */ }
    await fsp.rm(nodePath.dirname(out), { recursive: true, force: true }).catch(() => {});
  }
  return {
    t, processes: found, count: found.length,
    renderers: found.filter((p) => p.kind === "renderer").length,
    totalRssKb: found.reduce((a, p) => a + p.rssKb, 0),
    totalFootprintBytes: found.reduce((a, p) => a + (p.footprintBytes ?? 0), 0),
  };
}

function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length === 0 ? NaN : v[Math.floor((v.length - 1) / 2)];
}

module.exports = { sampleTree, median };
