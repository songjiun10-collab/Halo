"use strict";

function sumProcessTreeRssBytes(psOutput, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || typeof psOutput !== "string") return null;
  const rows = new Map();
  for (const line of psOutput.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssBytes = Number(match[3]) * 1024;
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid) && Number.isSafeInteger(rssBytes) && rssBytes >= 0) {
      rows.set(pid, { ppid, rssBytes });
    }
  }
  if (!rows.has(rootPid)) return null;
  const children = new Map();
  for (const [pid, row] of rows) {
    const list = children.get(row.ppid) || [];
    list.push(pid);
    children.set(row.ppid, list);
  }
  let total = 0;
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.get(pid);
    if (!row) continue;
    total += row.rssBytes;
    if (!Number.isSafeInteger(total)) return null;
    pending.push(...(children.get(pid) || []));
  }
  return total;
}

module.exports = { sumProcessTreeRssBytes };
