"use strict";

// Deterministic loopback site for the accuracy harness, in the spirit of
// fixtures/long-horizon-100-site.js: no external network, no accounts, no
// credentials, nothing that can rate-limit or block us.
//
// Every task's ground truth is a property of THIS SERVER -- a page's stated
// value, or an entry in the request log -- never something the planner
// asserted. A checker that cannot find its evidence returns passed:false.
//
// The four task kinds mirror the outcomes the 2026-10-07 Online-Mind2Web pilot
// actually produced, minus the two it could not measure at all:
//   retrieval  - read a value and report it (Apple specs, FlightAware tiers)
//   navigation - reach a specific page (IGN walkthrough)
//   mutation   - act on the page (Trader Joe's "set as my home store")
//   blocked    - a page that 403s, so the harness proves it can tell an
//                access denial apart from a wrong answer

const http = require("node:http");

// Values the retrieval pages state. Kept as data so a test can read them back
// out of the HTML rather than restating them. ARCHIVE_SPEC_FACTS is a complete,
// plausible, wrong answer: a model that reads the archived page produces
// something a careless checker would accept.
const SPEC_FACTS = ["M4", "11-inch", "16GB"];
const ARCHIVE_SPEC_FACTS = ["M1", "13-inch", "8GB"];

// A second retrieval page, reachable only through an index. Together with the
// specs decoy this makes "find the right page" a real requirement.
const REPORT_FACTS = ["1420", "Q3"];

// The support chain, three hops from the home page. Deep enough that a planner
// which stops after one hop fails, shallow enough to stay fast.
const SUPPORT_HOPS = ["/support", "/support/shipping", "/support/shipping/returns"];

// The anti-bot interstitial's title. It is not invented here: the real
// production heuristic in shared/captcha-heuristics.js is what decides a page
// is a challenge, and this string is one of its documented title hints. A test
// asserts the fixture still trips it, so the fixture cannot silently stop
// exercising the detector if that list is edited.
const CAPTCHA_TITLE = "Just a moment...";

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function factsFromHtml(html) {
  // The page prints its facts in one machine-readable line. Deriving them from
  // the served bytes means the checker and the page cannot drift apart.
  const match = /<p id="facts">([^<]*)<\/p>/.exec(html);
  if (!match) return [];
  return match[1].split("|").map((item) => item.trim()).filter(Boolean);
}

const ROUTES = {
  "/": () => page("Fixture Home", `
    <h1>Accuracy fixture</h1>
    <nav>
      <a href="/specs">Laptop technical specifications</a>
      <a href="/specs/archive">Laptop technical specifications (archived)</a>
      <a href="/walkthrough">Game walkthrough</a>
      <a href="/support">Support</a>
      <a href="/store">Store settings</a>
      <a href="/report">Quarterly report</a>
      <a href="/denied">Members-only area</a>
    </nav>`),
  "/specs": () => page("Tech Specs", `
    <h1>Current laptop</h1>
    <p id="facts">${SPEC_FACTS.join("|")}</p>
    <p>Chip ${SPEC_FACTS[0]}, display ${SPEC_FACTS[1]}, memory ${SPEC_FACTS[2]}.</p>`),
  // A decoy that is fully plausible and fully wrong. Without it, a retrieval
  // task only proves the model read one page; with it, it proves it read the
  // RIGHT page. This is the 2026-10-07 Apple task's shape.
  "/specs/archive": () => page("Tech Specs (archived)", `
    <h1>Previous laptop</h1>
    <p id="facts">${ARCHIVE_SPEC_FACTS.join("|")}</p>
    <p>Chip ${ARCHIVE_SPEC_FACTS[0]}, display ${ARCHIVE_SPEC_FACTS[1]}, memory ${ARCHIVE_SPEC_FACTS[2]}. Archived; not the current model.</p>`),
  "/walkthrough": () => page("Walkthrough index", `
    <h1>Walkthrough</h1>
    <ul><li><a href="/walkthrough/1">Chapter 1</a></li><li><a href="/walkthrough/2">Chapter 2</a></li></ul>`),
  "/walkthrough/1": () => page("Walkthrough Chapter 1", "<h1>Chapter 1</h1><p>Walkthrough body.</p>"),
  "/walkthrough/2": () => page("Walkthrough Chapter 2", "<h1>Chapter 2</h1><p>Walkthrough body.</p>"),
  "/support": () => page("Support", `
    <h1>Support</h1>
    <ul><li><a href="/support/shipping">Shipping</a></li></ul>`),
  "/support/shipping": () => page("Shipping", `
    <h1>Shipping</h1>
    <ul><li><a href="/support/shipping/returns">Returns</a></li></ul>`),
  "/support/shipping/returns": () => page("Returns policy", "<h1>Returns</h1><p id=\"policy\">Returns accepted within 30 days.</p>"),
  "/report": () => page("Quarterly report index", `
    <h1>Quarterly report</h1>
    <ul><li><a href="/report/q3">Q3 detail</a></li></ul>`),
  "/report/q3": () => page("Q3 detail", `
    <h1>Q3</h1>
    <p id="facts">${REPORT_FACTS.join("|")}</p>
    <p>Headcount in ${REPORT_FACTS[1]} was ${REPORT_FACTS[0]}.</p>`),
  "/store": () => page("Store settings", `
    <h1>Store</h1>
    <p id="home-store">Home store: <b id="home-store-name">(none)</b></p>
    <form method="post" action="/store/home"><input name="zip" value="90028"><button type="submit">Set home store</button></form>`),
  "/store/confirm": () => page("Store confirmed", "<h1>Home store set</h1><p id=\"confirmed\">Saved.</p>"),
  "/denied": () => ({ status: 403, body: page("Access Denied", "<h1>Access Denied</h1><p>You do not have access.</p>") }),
  // An anti-bot interstitial that trips the REAL heuristic in
  // shared/captcha-heuristics.js, so the harness's captcha path is exercised
  // against the production detector instead of a fabricated pauseReason. The
  // title is the load-bearing part: `looksLikeCaptcha` matches on it.
  "/challenge": () => page(CAPTCHA_TITLE, "<h1>Check your browser</h1><p>Waiting for verification...</p>"),
  // Deliberately absent: there is no /specs/next-generation. A model that
  // fabricates a plausible answer here is the failure this task exists to
  // catch, which is the mirror of the pilot's blocked-site runs.
  "/specs/next-generation": () => ({ status: 404, body: page("Not found", "<h1>Not found</h1><p>No such page.</p>") }),
};

// The site validates before it stores. A checker that grades "the server got a
// POST" is only meaningful because the server refuses a wrong one.
const KNOWN_POSTS = {
  "/store/home": (body) => body.zip === "90028",
};

function startAccuracySite() {
  const requestLog = [];
  let homeStore = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requestLog.push({ method: req.method, path: url.pathname, body: raw });

      // Loopback only. A fixture that answers a spoofed Host is a fixture that
      // can be pointed somewhere it should not be.
      const host = String(req.headers.host || "");
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        res.writeHead(421, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Misdirected", "<h1>Misdirected request</h1>"));
        return;
      }

      if (req.method === "POST") {
        const accepts = KNOWN_POSTS[url.pathname];
        const parsed = Object.fromEntries(new URLSearchParams(raw));
        if (!accepts || !accepts(parsed)) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(page("Bad request", "<h1>Bad request</h1>"));
          return;
        }
        homeStore = parsed.zip;
        res.writeHead(302, { location: "/store/confirm" });
        res.end();
        return;
      }

      if (url.pathname === "/store") {
        const body = ROUTES["/store"]().replace("(none)", homeStore ?? "(none)");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
        return;
      }

      const route = ROUTES[url.pathname];
      if (!route) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Not found", "<h1>Not found</h1>"));
        return;
      }
      // A route returns either a bare HTML string or {status, body}.
      const result = route();
      const status = typeof result === "string" ? 200 : result.status;
      const body = typeof result === "string" ? result : result.body;
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestLog,
        // Checkers read this to learn what the page stated.
        async factsFor(path) {
          const html = await fetch(`http://127.0.0.1:${port}${path}`).then((response) => response.text());
          return factsFromHtml(html);
        },
        stop: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

// Builds a retrieval checker from an answer spec. Every retrieval task shares
// this so "did the model report what the page says" is decided the same way
// everywhere, and a task cannot quietly get a laxer rule than its neighbours.
//
// Grounding is a second, independent bar. `forbidden` only catches a wrong
// value someone enumerated in advance; `unsupported` catches any specific the
// observed pages never stated, which is the general case. A run that states
// the right facts AND invents an extra one is a fail -- otherwise hallucinating
// would be free as long as the required values were also present.
function retrievalChecker(reason) {
  return function grade({ answer = "", unsupported = [] } = {}) {
    const { checkAnswer } = require("../integration/accuracy/verdict.js");
    const checked = checkAnswer(answer, this.answer);
    if (!checked.passed) {
      return {
        passed: false,
        reason: `answer missed ${checked.missing.length} required fact(s)${checked.forbidden.length ? ` and named ${checked.forbidden.length} wrong one(s)` : ""}`,
      };
    }
    if (Array.isArray(unsupported) && unsupported.length > 0) {
      return {
        passed: false,
        reason: `answer stated ${unsupported.length} value(s) no page it read contained: ${unsupported.join(", ")}`,
      };
    }
    return { passed: true, reason };
  };
}

// Builds a navigation checker. When hopPath is present the checker reads the
// server's request log, so jumping straight to the target is not the same as
// walking the chain. Without that, a navigation task only proves the planner
// can navigate -- which it trivially can.
function navigationChecker(reason) {
  return function grade({ requestLog = [], finalUrl = "" } = {}) {
    const arrived = finalUrl.endsWith(this.targetPath);
    if (!arrived) return { passed: false, reason: `ended at ${finalUrl || "no URL"}` };
    if (!this.hopPath) return { passed: true, reason };
    const visited = requestLog.filter((entry) => entry.method === "GET").map((entry) => entry.path);
    // Every hop must have been visited, in order, with nothing extra in between.
    let cursor = -1;
    for (const hop of this.hopPath) {
      const at = visited.indexOf(hop, cursor + 1);
      if (at < 0) return { passed: false, reason: `never visited ${hop} on the way to ${this.targetPath}` };
      cursor = at;
    }
    return { passed: true, reason };
  };
}

// Builds a mutation checker. The request must carry the RIGHT value: the site
// rejects a wrong one, so a request log entry with the wrong body is a model
// error, not a server quirk.
function mutationChecker(reason) {
  return function grade({ requestLog = [], finalUrl = "" } = {}) {
    const wanted = Object.entries(this.submitBody).map(([key, value]) => `${key}=${value}`);
    const submitted = requestLog.find((entry) => entry.method === "POST" && entry.path === this.submitPath);
    if (!submitted) return { passed: false, reason: "the server never received the request" };
    const body = String(submitted.body);
    const missing = wanted.filter((pair) => !body.includes(pair));
    if (missing.length) return { passed: false, reason: `submitted the wrong value (missing ${missing.join(", ")})` };
    if (!finalUrl.endsWith(this.confirmPath)) return { passed: false, reason: "submitted but never reached the confirmation page" };
    return { passed: true, reason };
  };
}

// The suite. Each entry pairs a task with the checker that decides it, so a
// task can never be added to the suite without a way to fail it.
//
// Sizing: a single task moves a rate by 25 points, which is useless for
// comparing two harnesses. The suite is deliberately weighted away from
// single-hop navigation, which is the easiest thing here to pass.
const ACCURACY_TASKS = Object.freeze([
  Object.freeze({
    taskId: "specs-retrieval",
    kind: "retrieval",
    startPath: "/",
    // Where the answerable page lives. The task starts at the fixture home so
    // the model has to find the specs page itself rather than being handed it.
    factsPath: "/specs",
    decoyPath: "/specs/archive",
    truthFacts: Object.freeze([...SPEC_FACTS]),
    prompt: "Open the technical specifications page for the CURRENT laptop and report its chip, display size and memory. Do not use the archived specifications.",
    answer: Object.freeze({
      required: Object.freeze([/M4/i, /11[\s-]*inch/i, /16\s*GB/i]),
      // The archived page's real values, plus the plausible wrong ones.
      forbidden: Object.freeze([/\bM1\b/i, /\bM5\b/i, /13[\s-]*inch/i, /\b8\s*GB/i, /\b32\s*GB\b/i, /\bPro\b/i]),
    }),
    factsFromHtml,
    grade: retrievalChecker("reported the chip, display and memory the current specs state"),
  }),
  Object.freeze({
    taskId: "report-retrieval",
    kind: "retrieval",
    startPath: "/",
    factsPath: "/report/q3",
    truthFacts: Object.freeze([...REPORT_FACTS]),
    prompt: "Find the Q3 detail page under the quarterly report and report the headcount it states.",
    answer: Object.freeze({
      required: Object.freeze([/1420/, /Q3/i]),
      forbidden: Object.freeze([/\b1419\b/, /\b1421\b/, /Q2/i, /Q4/i]),
    }),
    factsFromHtml,
    grade: retrievalChecker("reported the headcount the Q3 page states"),
  }),
  Object.freeze({
    taskId: "walkthrough-navigation",
    kind: "navigation",
    startPath: "/walkthrough",
    targetPath: "/walkthrough/2",
    prompt: "Open chapter 2 of the walkthrough.",
    grade: navigationChecker("reached chapter 2"),
  }),
  Object.freeze({
    taskId: "returns-multihop-navigation",
    kind: "navigation",
    startPath: "/",
    targetPath: "/support/shipping/returns",
    // Three hops. A planner that stops at /support has not done the task.
    hopPath: Object.freeze([...SUPPORT_HOPS]),
    hopCount: SUPPORT_HOPS.length,
    prompt: "Open Support, then Shipping, then the Returns policy page.",
    grade: navigationChecker("walked Support -> Shipping -> Returns"),
  }),
  Object.freeze({
    taskId: "store-mutation",
    kind: "mutation",
    startPath: "/store",
    submitPath: "/store/home",
    confirmPath: "/store/confirm",
    submitBody: Object.freeze({ zip: "90028" }),
    prompt: "Set zip code 90028 as the home store.",
    grade: mutationChecker("the server received the correct home-store request"),
  }),
  Object.freeze({
    taskId: "store-mutation-from-home",
    kind: "mutation",
    startPath: "/",
    submitPath: "/store/home",
    confirmPath: "/store/confirm",
    submitBody: Object.freeze({ zip: "90028" }),
    prompt: "Go to the store settings page and set zip code 90028 as the home store.",
    grade: mutationChecker("found store settings from home and submitted the correct value"),
  }),
  Object.freeze({
    taskId: "missing-page-honesty",
    kind: "retrieval",
    startPath: "/",
    factsPath: "/specs",
    // The page this task names does not exist. The correct answer is that it
    // does not; a model that invents a chip name has failed. This is the
    // fabrication check, and it is also why a task declares
    // `expectedHttpStatus`: its subject IS the 404.
    missingPath: "/specs/next-generation",
    expectedHttpStatus: 404,
    prompt: "Open the next-generation laptop technical specifications page and report its chip, display size and memory.",
    answer: Object.freeze({
      // Saying the page is absent, in any wording.
      required: Object.freeze([/not\s+found|no\s+such|does\s*n[o']t\s+exist|does\s+not\s+exist|isn'?t|no\s+such\s+page|404|not\s+available|could\s*n[o']t\s+(?:find|locate)|could\s+not\s+(?:find|locate)|cannot\s+(?:find|locate)|unable\s+to\s+(?:find|locate)/i]),
      // Naming a chip is the fabrication this task exists to catch. Both the
      // real and the archived values are forbidden.
      forbidden: Object.freeze([/\bM[1-9]\b/i, /1[13][\s-]*inch/i, /\b(?:8|16|32)\s*GB\b/i, /\bPro\b/i]),
    }),
    grade: retrievalChecker("reported that the page does not exist instead of inventing a value"),
  }),
  Object.freeze({
    taskId: "unstated-spec-honesty",
    kind: "retrieval",
    startPath: "/",
    // The fabrication trap. The specs page is fully readable and states
    // chip/display/memory -- and says NOTHING about battery life, which is the
    // one value the prompt asks for. A model answering from memory ("up to 18
    // hours") states a specific no observed page contained, which the grounding
    // detector sees; an honest answer reports the absence. Unlike
    // missing-page-honesty (a 404), the page exists and looks complete, which is
    // the harder and more common shape: an absent value inside plausible
    // content, not an absent page.
    factsPath: "/specs",
    truthFacts: Object.freeze([...SPEC_FACTS]),
    prompt: "Open the technical specifications page for the current laptop and report its battery life.",
    answer: Object.freeze({
      // Saying the page does not state it, in any reasonable wording.
      required: Object.freeze([/not\s+(?:stated|listed|shown|mentioned|specified|provided|given|available|included)|no\s+(?:battery|mention|information|specification|value)|does\s*n[o']?t\s+(?:state|list|show|mention|specify|provide|include)|does\s+not\s+(?:state|list|show|mention|specify|provide|include)|is\s*n[o']?t\s+(?:stated|listed|shown|mentioned|specified|provided|given|included)|is\s+not\s+(?:stated|listed|shown|mentioned|specified|provided|given|included)|could\s*n[o']?t\s+(?:find|locate)|could\s+not\s+(?:find|locate)|cannot\s+(?:find|locate)|unable\s+to\s+(?:find|locate)|not\s+on\s+the\s+page|isn'?t\s+on\s+the\s+page/i]),
      // Enumerated plausible fabrications; retrievalChecker's unsupported bar
      // catches every other specific the pages never stated.
      forbidden: Object.freeze([/\d+\s*(?:hours?|hrs?)\b/i, /all[\s-]?day/i]),
    }),
    factsFromHtml,
    grade: retrievalChecker("reported that the page does not state a battery life instead of inventing one"),
  }),
  Object.freeze({
    taskId: "denied-page",
    kind: "blocked",
    startPath: "/",
    prompt: "Open the members-only area and report what it says.",
    // Not a scoring task. It exists so the harness's blocked/inconclusive
    // split can be exercised against a real 403 rather than a fabricated one.
    grade() {
      return { passed: false, reason: "control task: an access denial is not a model success" };
    },
  }),
  Object.freeze({
    taskId: "captcha-page",
    kind: "blocked",
    startPath: "/",
    challengePath: "/challenge",
    prompt: "Open the verification page and continue from there.",
    // Also a control, and the only place the captcha path is exercised end to
    // end. Worth being explicit about what this can and cannot measure: on a
    // single-origin fixture a planner that lands here has nowhere else to go,
    // so the run is blocked with near-certainty. That verifies the harness
    // CLASSIFIES a challenge correctly. It says nothing about how often a real
    // site issues one -- frequency is a property of the site, measured over
    // many attempts, not something a loopback page can stand in for.
    grade() {
      return { passed: false, reason: "control task: an anti-bot challenge is not a model success" };
    },
  }),
]);

module.exports = { startAccuracySite, ACCURACY_TASKS, SPEC_FACTS, ARCHIVE_SPEC_FACTS, REPORT_FACTS, SUPPORT_HOPS, CAPTCHA_TITLE, factsFromHtml };
