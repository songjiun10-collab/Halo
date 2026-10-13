"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUrl, domainOf, extractCitedUrls, SourceLedger, checkAnswer, sourcesBlock, unverifiedNotice } = require("../main/harness/research-sources");

test("one page, one identity: scheme, www, fragment, trailing slash, tracking params and query order do not matter", () => {
  const a = normalizeUrl("https://www.Example.com/post/?utm_source=x&b=2&a=1#top");
  assert.equal(a, normalizeUrl("http://example.com/post?a=1&b=2"));
  assert.notEqual(a, normalizeUrl("https://example.com/other?a=1&b=2"), "a different path is a different page");
  assert.notEqual(normalizeUrl("https://example.com/p?id=1"), normalizeUrl("https://example.com/p?id=2"), "real query parameters still count");
  for (const bad of ["ftp://x.com", "javascript:alert(1)", "not a url", "https://user:pw@x.com/", "", null, undefined, 5]) assert.equal(normalizeUrl(bad), null, String(bad));
  assert.equal(normalizeUrl("https://x.com/" + "a".repeat(3000)), null, "oversized urls are refused");
});

test("registrable domains group subdomains of one site", () => {
  assert.equal(domainOf("https://news.example.co.uk/a"), "example.co.uk");
  assert.equal(domainOf("https://blog.example.com/a"), domainOf("https://www.example.com/b"));
  assert.notEqual(domainOf("https://a.com/"), domainOf("https://b.com/"));
});

test("cited urls are found in Korean and English prose without trailing punctuation", () => {
  assert.deepEqual(extractCitedUrls("근거는 https://a.com/x입니다. 또 (https://b.org/y?z=1), 그리고 https://a.com/x."), ["https://a.com/x", "https://b.org/y?z=1"]);
  assert.deepEqual(extractCitedUrls("see <https://c.net/p>; and 'https://d.io/q'!"), ["https://c.net/p", "https://d.io/q"]);
  assert.deepEqual(extractCitedUrls("no links here"), []);
  assert.deepEqual(extractCitedUrls(undefined), []);
});

test("the ledger keeps only pages it was told about, once each, bounded", () => {
  const ledger = new SourceLedger();
  assert.equal(ledger.add({ url: "https://a.com/x", title: "  A   page ", at: 1 }), true);
  assert.equal(ledger.add({ url: "https://www.a.com/x/?utm_source=z", at: 2 }), false, "same page");
  assert.equal(ledger.add({ url: "javascript:alert(1)" }), false);
  assert.equal(ledger.find("http://a.com/x#frag").title, "A page");
  assert.equal(ledger.find("https://a.com/never"), null);
  const big = new SourceLedger();
  for (let i = 0; i < 80; i += 1) big.add({ url: `https://s${i}.com/p`, at: i });
  assert.equal(big.size, 60);
  assert.equal(big.find("https://s0.com/p"), null, "the oldest is dropped");
  assert.ok(big.find("https://s79.com/p"));
});

test("an answer passes only when everything it cites was opened and at least two independent sites back it", () => {
  const ledger = new SourceLedger([{ url: "https://a.com/x", title: "A", at: 1 }, { url: "https://blog.a.com/y", at: 2 }, { url: "https://b.org/z", title: "B", at: 3 }]);
  const good = checkAnswer("Claim one (https://a.com/x). Claim two (https://b.org/z).", ledger);
  assert.equal(good.ok, true);
  assert.equal(good.independentSites, 2);
  const noCites = checkAnswer("It is true, trust me.", ledger);
  assert.deepEqual(noCites.reasons, ["no_sources"]);
  const invented = checkAnswer("Claim (https://a.com/x) and (https://b.org/z) and (https://made-up.com/q).", ledger);
  assert.deepEqual(invented.reasons, ["unverified_source"]);
  assert.deepEqual(invented.unverified, ["https://made-up.com/q"]);
  const sameSite = checkAnswer("Claim (https://a.com/x) and (https://blog.a.com/y).", ledger);
  assert.deepEqual(sameSite.reasons, ["too_few_sources"], "two pages of one site are one source");
  const onlyFake = checkAnswer("Claim (https://made-up.com/q).", ledger);
  assert.deepEqual(onlyFake.reasons.sort(), ["too_few_sources", "unverified_source"]);
});

test("the host's source list and the unverified notice are plain, bounded text", () => {
  const ledger = new SourceLedger([{ url: "https://a.com/x", title: "A page", at: Date.UTC(2026, 9, 13, 12, 30) }]);
  assert.match(sourcesBlock(ledger.list()), /Sources Halo opened \(host-verified\):\n1\. A page - https:\/\/a\.com\/x \(opened 2026-10-13 12:30 UTC\)/);
  assert.equal(sourcesBlock([]), "");
  const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://s${i}.com/p`, title: "t", at: 0 }));
  assert.equal(sourcesBlock(many).split("\n").filter((l) => /^\d+\./.test(l)).length, 8);
  const notice = unverifiedNotice({ reasons: ["unverified_source", "too_few_sources"], unverified: ["https://x.com/1", "https://x.com/2"] });
  assert.match(notice, /Not verified by Halo: it cites 2 pages Halo never opened; fewer than 2 independent sites were verified/);
});
