"use strict";

// CAPTCHA defense bench: both costs of the flat-hint detector, measured.
//
// The captcha defense in this app is shared/captcha-heuristics.js's
// looksLikeCaptcha(): two flat string-hint lists, substring matching on the
// URL and title Electron already reports. Its ONLY job is to decide whether
// to pause and hand the browser to a human (main/control-api.js sets
// captchaSuspected; main/harness/task-controller.js pauses the observation
// loop on it). It never reads DOM content, never inspects challenge tokens,
// and is never used to solve, click through, or route around anything.
//
// This bench attacks that decision boundary from both sides (the
// false_block_benchmark.py discipline, ported to the captcha boundary):
//
//   benign/        — realistic non-challenge pages: the detector must NOT
//                    flag. Any flag is a false pause — a human handoff the
//                    session did not need (the frequency cost).
//   adversarial/   — challenge pages constructed against the flat-hint
//                    design: the detector MUST flag. A miss means the agent
//                    sails into a live challenge without pausing. Misses are
//                    split by mechanism:
//                      reachable   — the challenge marker IS in the url/title
//                                    the heuristic sees; extending the hint
//                                    lists could close it (hint-list gap).
//                      structural  — the marker never reaches the heuristic
//                                    (obfuscated bytes, non-English titles,
//                                    challenge hidden in an iframe); closing
//                                    it needs more than hint lists (OPEN).
//   mixed-stream/  — a simulated session at an ASSUMED challenge prevalence
//                    (made-up, not measured): pause rate, pause precision,
//                    and challenge recall on the same stream.
//   wba-scenarios/ — the same stream under Web Bot Auth identity: signed vs
//                    unsigned agents across sites that do or don't verify
//                    signatures. Site policies (who gets challenged at what
//                    rate, what fraction of signatures fail verification)
//                    are ASSUMED inputs, labeled as such; the measured part
//                    is still looksLikeCaptcha's response to the page
//                    stream those policies produce.
//
// All pages are synthetic, in-process strings: no network, no Electron, no
// vendor SDKs, and nothing here solves, bypasses, or auto-completes any
// CAPTCHA — it only measures how often the detector raises (or fails to
// raise) its hand. Vendor domains and interstitial titles below are real
//-world examples, not measured endpoints.
//
// Usage: node bench/captcha-defense-bench.js [iterations] [prevalencePercent]

const {
  looksLikeCaptcha,
  CAPTCHA_HOST_HINTS,
  CAPTCHA_TITLE_HINTS,
} = require("../shared/captcha-heuristics");

// ---------------------------------------------------------------- corpora --

// (name, category, url, title) — categories exist so the worst-group rate
// (E004 discipline) is visible alongside the mean. The "near-miss" category
// holds pages that DO contain a hint substring in a benign context: they are
// the measured false-pause cost, not corpus bugs.
const BENIGN = [
  // docs/dev
  ["mdn fetch", "docs", "https://developer.mozilla.org/en-US/docs/Web/API/fetch", "fetch() - Web APIs | MDN"],
  ["github repo", "docs", "https://github.com/example/repo", "GitHub - example/repo"],
  ["github PR", "docs", "https://github.com/example/repo/pull/42", "Fix race in lease renewal · Pull Request #42"],
  ["stackoverflow", "docs", "https://stackoverflow.com/questions/what-is-a-callback", "What is a callback function? - Stack Overflow"],
  ["node docs", "docs", "https://nodejs.org/api/fs.html", "File system | Node.js v24 documentation"],
  ["npm package", "docs", "https://www.npmjs.com/package/tldts", "tldts - npm"],
  ["caniuse", "docs", "https://caniuse.com/webp", "Can I use WebP? Support tables"],
  ["hacker news", "docs", "https://news.ycombinator.com/item?id=12345678", "Show HN: I built a thing | Hacker News"],
  // news/editorial
  ["example news", "news", "https://news.example.com/article/42", "Today's Headlines — Example News"],
  ["bbc tech", "news", "https://www.bbc.com/news/technology-12345678", "Chip exports explained - BBC News"],
  ["engineering blog", "news", "https://blog.example.com/posts/measure-before-optimizing", "Measure before optimizing — Example Engineering Blog"],
  // search
  ["google search", "search", "https://www.google.com/search?q=halo+containment", "halo containment - Google Search"],
  ["duckduckgo", "search", "https://duckduckgo.com/?q=turnstile+widget", "turnstile widget at DuckDuckGo"],
  ["bing search", "search", "https://www.bing.com/search?q=node+test+runner", "node test runner - Bing"],
  // productivity
  ["webmail", "productivity", "https://mail.example.com/inbox", "Inbox (12) - Example Mail"],
  ["calendar", "productivity", "https://calendar.example.com/week", "Calendar - Week of October 10, 2026"],
  ["docs editor", "productivity", "https://docs.example.com/document/d/abc123/edit", "Q3 planning notes - Google Docs"],
  ["spreadsheet", "productivity", "https://sheets.example.com/spreadsheets/d/xyz", "Metrics dashboard - Sheets"],
  // commerce
  ["product page", "commerce", "https://shop.example.com/products/keyboard", "Mechanical Keyboard — Example Store"],
  ["cart", "commerce", "https://shop.example.com/cart", "Your cart (2 items) — Example Store"],
  ["checkout", "commerce", "https://shop.example.com/checkout", "Checkout — Example Store"],
  // near-miss benign: a hint substring appears in a benign context. These
  // flag today and are recorded as false pauses (the frequency cost).
  ["hcaptcha vendor docs", "near-miss", "https://docs.hcaptcha.com/welcome/", "hCaptcha documentation"],
  ["security checklist doc", "near-miss", "https://support.example.com/articles/security-checklist", "Security checklist for rotating API keys — Support"],
  ["attention-required release note", "near-miss", "https://blog.example.com/2026/release-1-2", "Attention required: migrating off TLS 1.0 — Example Engineering Blog"],
  ["browser compatibility doc", "near-miss", "https://docs.example.com/guides/browser-compat", "Checking your browser compatibility matrix — Docs"],
];

// { name, family, mechanism, url, title, iframe? } — mechanism is why the
// vector is (or is not) reachable by substring matching:
//   "reachable"  — the marker is literally in the url/title the heuristic
//                  sees; extending the hint lists could close a miss.
//   "structural" — the marker never reaches the heuristic as a matching
//                  substring (different bytes, different language, or a
//                  challenge in an iframe the heuristic never looks at).
// The "baseline" family is what the current hints already cover; it must
// stay held and acts as the regression floor for the bench itself.
const ADVERSARIAL = [
  // baseline — known-covered vendors and titles (must hold)
  { name: "reCAPTCHA host", family: "baseline", mechanism: "reachable", url: "https://www.google.com/recaptcha/api2/anchor", title: "" },
  { name: "reCAPTCHA mirror host", family: "baseline", mechanism: "reachable", url: "https://recaptcha.net/recaptcha/api2/anchor", title: "" },
  { name: "hCaptcha host", family: "baseline", mechanism: "reachable", url: "https://hcaptcha.com/checkbox", title: "" },
  { name: "Cloudflare Turnstile host", family: "baseline", mechanism: "reachable", url: "https://challenges.cloudflare.com/turnstile", title: "" },
  { name: "DataDome host", family: "baseline", mechanism: "reachable", url: "https://geo.captcha-delivery.com/interstitial/", title: "" },
  { name: "Arkose host", family: "baseline", mechanism: "reachable", url: "https://client-api.arkoselabs.com/v2/", title: "" },
  { name: "PerimeterX host", family: "baseline", mechanism: "reachable", url: "https://captcha.px-cdn.net/1234/challenge.js", title: "" },
  { name: "CF title: Just a moment", family: "baseline", mechanism: "reachable", url: "https://example.com/", title: "Just a moment..." },
  { name: "CF title: Attention Required", family: "baseline", mechanism: "reachable", url: "https://example.com/", title: "Attention Required! | Cloudflare" },
  { name: "title: verify you are human", family: "baseline", mechanism: "reachable", url: "https://example.com/", title: "Please verify you are human" },

  // title variants — real-world English interstitial titles not in the list
  { name: "CF title: Verifying you are human", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Verifying you are human. This may take a few seconds…" },
  { name: "CF title: One more step", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "example.com | One more step" },
  { name: "PX title: Press & Hold", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Press & Hold to continue" },
  { name: "title: Confirm you are a human", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Confirm you are a human" },
  { name: "CF title: Checking if site connection secure", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Checking if the site connection is secure" },
  { name: "title: Bot Verification", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Bot Verification" },
  { name: "title: Human Verification Required", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Human Verification Required" },
  { name: "Imperva title: Incapsula incident ID", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "Request unsuccessful. Incapsula incident ID: 1234567890123456789-123456789" },
  { name: "StackPath title: DDoS protection", family: "title-variants", mechanism: "reachable", url: "https://example.com/", title: "DDoS protection by StackPath" },

  // unlisted vendors — real vendor domains missing from the host-hint list
  { name: "GeeTest host", family: "unlisted-vendors", mechanism: "reachable", url: "https://gt4.geetest.com/load/", title: "" },
  { name: "MTCaptcha host", family: "unlisted-vendors", mechanism: "reachable", url: "https://mtcaptcha.com/widget", title: "" },
  { name: "KeyCAPTCHA host", family: "unlisted-vendors", mechanism: "reachable", url: "https://api.keycaptcha.com/", title: "" },
  { name: "Friendly Captcha host", family: "unlisted-vendors", mechanism: "reachable", url: "https://api.friendlycaptcha.com/api/v2/puzzle", title: "" },
  { name: "Altcha host", family: "unlisted-vendors", mechanism: "reachable", url: "https://altcha.org/", title: "" },

  // self-hosted — challenge served on the origin's own path; no vendor host
  // and a benign title, so only a generic path hint could catch these
  { name: "AWS WAF-style /captcha path", family: "self-hosted", mechanism: "reachable", url: "https://shop.example.com/captcha?state=abc123", title: "Checkout — Example Store" },
  { name: "origin /_challenge path", family: "self-hosted", mechanism: "reachable", url: "https://api.example.com/_challenge?sid=123", title: "Example API" },

  // unicode obfuscation — visually identical to a hint, different bytes;
  // lowercased substring matching cannot close these by construction
  { name: "fullwidth J (U+FF2A)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "\uFF2Aust a moment..." },
  { name: "Cyrillic Je (U+0408)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "\u0408ust a moment..." },
  { name: "zero-width space (U+200B)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "just a m\u200boment..." },
  { name: "soft hyphen (U+00AD)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "veri\u00adfy you are human" },
  { name: "fi ligature (U+FB01)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "Con\uFB01rm you are a human" },
  { name: "precomposed e-acute (U+00E9)", family: "unicode-obfuscation", mechanism: "structural", url: "https://example.com/", title: "just a mom\u00e9nt..." },

  // localized titles — representative localized variants of the same
  // interstitials (exact vendor strings vary per request); any non-English
  // title defeats an English-only hint list by construction
  { name: "zh-CN interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "请稍候…" },
  { name: "de interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "Einen Moment bitte…" },
  { name: "ja interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "しばらくお待ちください…" },
  { name: "ko interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "잠시만 기다려 주세요" },
  { name: "es interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "Un momento…" },
  { name: "fr interstitial title", family: "localized-titles", mechanism: "structural", url: "https://example.com/", title: "Veuillez patienter…" },

  // iframe-hidden — top-page url/title stay clean while the challenge runs
  // in a cross-origin iframe; the heuristic only sees what Electron reports
  // for the top page, so it cannot see these by construction
  { name: "hCaptcha in checkout iframe", family: "iframe-hidden", mechanism: "structural", url: "https://shop.example.com/checkout", title: "Checkout — Example Store", iframe: "https://hcaptcha.com/checkbox" },
  { name: "Turnstile in signup iframe", family: "iframe-hidden", mechanism: "structural", url: "https://example.com/signup", title: "Create your account", iframe: "https://challenges.cloudflare.com/turnstile" },
  { name: "DataDome in paywall iframe", family: "iframe-hidden", mechanism: "structural", url: "https://news.example.com/paywall", title: "Subscriber-only article", iframe: "https://geo.captcha-delivery.com/interstitial/" },
];

// ---------------------------------------------------------------- measure --

function evaluateBenign(entries = BENIGN) {
  return entries.map(([name, category, url, title]) => ({
    name,
    category,
    flagged: looksLikeCaptcha(url, title),
  }));
}

function evaluateAdversarial(entries = ADVERSARIAL) {
  return entries.map((entry) => ({
    name: entry.name,
    family: entry.family,
    mechanism: entry.mechanism,
    iframe: entry.iframe ?? null,
    held: looksLikeCaptcha(entry.url, entry.title),
  }));
}

// Tiny deterministic LCG so the mixed stream is reproducible per seed.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Simulated browsing session at an ASSUMED challenge prevalence. Challenge
// pages cycle through the adversarial corpus, benign pages through the
// benign corpus (near-misses included — they are real traffic). Precision
// with zero pauses is vacuously 1 (no false pauses were made).
//
// Web Bot Auth inputs (all ASSUMED, not measured):
//   wbaSiteShare         — fraction of sites that verify WBA signatures
//   signed               — whether OUR outbound requests carry signatures
//   signedResidualRate   — residual challenge rate a WBA-honoring site still
//                          applies to a verified agent (its policy choice)
//   signatureFailureRate — fraction of signed requests whose verification
//                          fails (expired clock, key rotation, tampering);
//                          a failed signature is treated as unsigned.
// The ASSUMED site policy: a WBA-honoring site passes verified agents
// through without a challenge (up to signedResidualRate); every other load
// sees the full prevalence.
function simulateStream({
  seed = 20261010,
  iterations = 200,
  prevalence = 0.05,
  wbaSiteShare = 0,
  signed = false,
  signedResidualRate = 0,
  signatureFailureRate = 0,
} = {}) {
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error(`iterations must be a positive integer, got ${iterations}`);
  }
  if (!(typeof prevalence === "number") || !(prevalence > 0 && prevalence < 1)) {
    throw new Error(`prevalence must be in (0, 1), got ${prevalence}`);
  }
  for (const [name, value] of [
    ["wbaSiteShare", wbaSiteShare],
    ["signedResidualRate", signedResidualRate],
    ["signatureFailureRate", signatureFailureRate],
  ]) {
    if (!(typeof value === "number") || !(value >= 0 && value <= 1)) {
      throw new Error(`${name} must be in [0, 1], got ${value}`);
    }
  }
  const rng = lcg(seed);
  let pauses = 0;
  let challengeCount = 0;
  let challengesPaused = 0;
  let benignCount = 0;
  let benignPaused = 0;
  let verifiedCount = 0;
  for (let i = 0; i < iterations; i++) {
    const siteHonorsWba = rng() < wbaSiteShare;
    const signatureValid = !signed || rng() >= signatureFailureRate;
    const verified = siteHonorsWba && signed && signatureValid;
    if (verified) verifiedCount++;
    const challengeRate = verified ? signedResidualRate : prevalence;
    const isChallenge = rng() < challengeRate;
    // rng-based pick, so even a short session samples the whole corpus mix
    // (round-robin from index 0 would sample only the held baseline first).
    const page = isChallenge
      ? ADVERSARIAL[Math.floor(rng() * ADVERSARIAL.length)]
      : BENIGN[Math.floor(rng() * BENIGN.length)];
    const url = isChallenge ? page.url : page[2];
    const title = isChallenge ? page.title : page[3];
    const flagged = looksLikeCaptcha(url, title);
    if (isChallenge) {
      challengeCount++;
      if (flagged) challengesPaused++;
    } else {
      benignCount++;
      if (flagged) benignPaused++;
    }
    if (flagged) pauses++;
  }
  return {
    seed,
    iterations,
    prevalence,
    wbaSiteShare,
    signed,
    signedResidualRate,
    signatureFailureRate,
    pauses,
    pauseRate: pauses / iterations,
    challengeCount,
    challengeRecall: challengeCount > 0 ? challengesPaused / challengeCount : 1,
    benignCount,
    benignPaused,
    pausePrecision: pauses > 0 ? challengesPaused / pauses : 1,
    verifiedCount,
  };
}

// ----------------------------------------------------------------- report --

function main() {
  const iterations = Number(process.argv[2]) || 200;
  const prevalence = (Number(process.argv[3]) || 5) / 100;

  console.log("=== captcha defense bench (flat-hint detector: looksLikeCaptcha) ===");
  console.log(`hint lists: ${CAPTCHA_HOST_HINTS.length} host hints, ${CAPTCHA_TITLE_HINTS.length} title hints\n`);

  const benign = evaluateBenign();
  console.log("[benign — non-challenge pages; flag = false pause]");
  const falsePauses = [];
  const byCategory = new Map();
  for (const entry of benign) {
    const mark = entry.flagged ? "FALSE PAUSE" : "ok";
    console.log(`  ${entry.name.padEnd(34)} (${entry.category})  -> ${mark}`);
    if (entry.flagged) falsePauses.push(entry);
    const bucket = byCategory.get(entry.category) ?? { total: 0, flagged: 0 };
    bucket.total++;
    if (entry.flagged) bucket.flagged++;
    byCategory.set(entry.category, bucket);
  }
  const passRate = (benign.length - falsePauses.length) / benign.length;
  console.log(`  pass rate: ${benign.length - falsePauses.length}/${benign.length} = ${(passRate * 100).toFixed(1)}%`
    + `   (frequency cost: ${falsePauses.length} false pauses on normal traffic)`);
  const worstCategory = [...byCategory.entries()]
    .filter(([, b]) => b.flagged > 0)
    .map(([name, b]) => ({ name, rate: b.flagged / b.total }))
    .sort((a, b) => b.rate - a.rate)[0];
  if (worstCategory) {
    console.log(`  worst category (E004): ${worstCategory.name} — ${(worstCategory.rate * 100).toFixed(0)}% flagged`);
  }

  const adversarial = evaluateAdversarial();
  console.log("\n[adversarial — challenge pages; flag = held, miss = got through]");
  const families = new Map();
  const reachableMisses = [];
  const structuralOpens = [];
  for (const entry of adversarial) {
    const bucket = families.get(entry.family) ?? { total: 0, held: 0 };
    bucket.total++;
    if (entry.held) bucket.held++;
    families.set(entry.family, bucket);
    const mark = entry.held ? "HELD" : "MISS";
    const extra = entry.iframe ? `  (challenge in iframe: ${entry.iframe})` : "";
    console.log(`  ${entry.name.padEnd(44)} [${entry.family}]  -> ${mark}${extra}`);
    if (!entry.held) {
      if (entry.mechanism === "reachable") reachableMisses.push(entry);
      else structuralOpens.push(entry);
    }
  }
  console.log("  per family:");
  for (const [family, bucket] of families) {
    console.log(`    ${family.padEnd(22)} held ${bucket.held}/${bucket.total}`);
  }

  const stream = simulateStream({ iterations, prevalence });
  console.log(`\n[mixed-stream — simulated session, seed=${stream.seed}, ${stream.iterations} pages]`);
  console.log(`  prevalence ${prevalence * 100}% — ASSUMED, not a measured value`);
  console.log(`  pauses: ${stream.pauses} (${(stream.pauseRate * 100).toFixed(1)}% of pages)`);
  console.log(`  pause precision: ${(stream.pausePrecision * 100).toFixed(1)}% of pauses were real challenges`
    + ` (${stream.benignPaused} false pauses from ${stream.benignCount} benign pages)`);
  console.log(`  challenge recall: ${(stream.challengeRecall * 100).toFixed(1)}% of ${stream.challengeCount} challenges triggered a pause`);

  const wbaScenarios = [
    { name: "unsigned agent, 0% WBA sites (today's world)", wbaSiteShare: 0, signed: false },
    { name: "unsigned agent, 100% WBA sites (unsigned anyway)", wbaSiteShare: 1, signed: false },
    { name: "signed agent, 50% WBA sites", wbaSiteShare: 0.5, signed: true },
    { name: "signed agent, 100% WBA sites", wbaSiteShare: 1, signed: true },
    { name: "signed agent, 100% WBA sites, 10% signature failures", wbaSiteShare: 1, signed: true, signatureFailureRate: 0.1 },
  ];
  console.log(`\n[wba scenarios — same ${iterations}-page stream; site policies ASSUMED, not measured]`);
  const wbaResults = wbaScenarios.map((scenario) => {
    const scenarioStream = simulateStream({ seed: stream.seed, iterations, prevalence, ...scenario });
    return { name: scenario.name, ...scenarioStream };
  });
  for (const r of wbaResults) {
    const challengePauses = r.challengeCount > 0 ? Math.round(r.challengeRecall * r.challengeCount) : 0;
    console.log(`  ${r.name.padEnd(52)} challenges ${String(r.challengeCount).padStart(3)}/${r.iterations}`
      + `  pauses ${String(r.pauses).padStart(3)} (${(r.pauseRate * 100).toFixed(1)}%)`
      + `  of which false ${String(r.benignPaused).padStart(3)}  verified ${r.verifiedCount}`);
  }
  const today = wbaResults[0];
  const fullWba = wbaResults[3];
  const reduction = today.challengeCount > 0 ? 1 - fullWba.challengeCount / today.challengeCount : 0;
  console.log(`  challenge volume, signed+100% WBA vs unsigned baseline:`
    + ` ${today.challengeCount} -> ${fullWba.challengeCount} (${(reduction * 100).toFixed(0)}% reduction)`
    + ` — driven by the ASSUMED site policy, not a measurement`);

  console.log("\n== summary ==");
  console.log(`  benign pass rate (usefulness cost): ${(passRate * 100).toFixed(1)}%`
    + ` — false pauses: ${falsePauses.map((e) => e.name).join(", ") || "none"}`);
  console.log(`  reachable misses (hint-list gap, fixable now): ${reachableMisses.length}`);
  for (const entry of reachableMisses) {
    console.log(`    HINT GAP: [${entry.family}] ${entry.name}`);
  }
  console.log(`  structural misses (OPEN — needs more than hint lists): ${structuralOpens.length}`);
  for (const entry of structuralOpens) {
    console.log(`    OPEN: [${entry.family}] ${entry.name}`);
  }
  if (reachableMisses.length === 0 && structuralOpens.length === 0) {
    console.log("  all adversarial vectors held.");
  }

  const summary = {
    hint_counts: { host: CAPTCHA_HOST_HINTS.length, title: CAPTCHA_TITLE_HINTS.length },
    benign_total: benign.length,
    benign_flagged: falsePauses.length,
    benign_pass_rate: passRate,
    worst_category: worstCategory ?? null,
    adversarial_total: adversarial.length,
    per_family: Object.fromEntries(families),
    reachable_misses: reachableMisses.map((e) => ({ name: e.name, family: e.family })),
    structural_opens: structuralOpens.map((e) => ({ name: e.name, family: e.family })),
    stream,
    wba_scenarios: wbaResults.map(({ name, ...scenarioStream }) => ({ name, ...scenarioStream })),
  };
  console.log("\nJSON:");
  console.log(JSON.stringify(summary, null, 2));

  // A reachable miss is a hint-list gap that could be closed today; a
  // baseline miss would mean an existing defense regressed. Structural
  // misses are known open findings of the flat-hint design, not failures.
  return reachableMisses.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  BENIGN,
  ADVERSARIAL,
  evaluateBenign,
  evaluateAdversarial,
  simulateStream,
  lcg,
};
