"use strict";

// One stray rejection (a command sent to a page that just closed, a listener that throws) must not take down
// the host and every task running in it. Node ends the process on both by default. They are logged and the
// host keeps going. A process that keeps failing in a tight loop is a different case: after `limit` errors
// inside `windowMs` it exits, so the service manager starts a clean one instead of leaving a zombie.
function describe(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack.split("\n").slice(1, 6).join("\n")}` : ""}`;
    if (typeof value === "string") return value.slice(0, 500);
    return JSON.stringify(value)?.slice(0, 500) ?? String(value);
  } catch { return Object.prototype.toString.call(value); }
}

function installProcessGuard(proc = process, { log = console.error, exit = (code) => proc.exit(code), now = Date.now, limit = 20, windowMs = 60_000 } = {}) {
  const recent = [];
  const tooMany = () => {
    const at = now();
    recent.push(at);
    while (recent.length && at - recent[0] > windowMs) recent.shift();
    return recent.length > limit;
  };
  const handle = (label) => (value) => {
    try { log(`[process] ${label}:`, describe(value)); } catch { /* logging must not throw into the handler */ }
    if (tooMany()) {
      try { log(`[process] more than ${limit} errors in ${windowMs / 1000}s; exiting so a clean process can start`); } catch { /* ignore */ }
      exit(1);
    }
  };
  const onRejection = handle("unhandled rejection");
  const onException = handle("uncaught exception");
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  return { uninstall() { proc.off("unhandledRejection", onRejection); proc.off("uncaughtException", onException); } };
}

module.exports = { installProcessGuard };
