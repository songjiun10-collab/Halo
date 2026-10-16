"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractPdfText, formatPdfObservationText, looksLikePdfUrl } = require("../main/harness/pdf-text");

// Smallest PDF with one page of Helvetica text; built here so the test needs no fixture file.
function makePdf(lines) {
  const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((line, i) => `${i ? "0 -16 Td " : ""}(${line}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const respond = (bytes, type = "application/pdf") => async () => new Response(bytes, { headers: { "content-type": type } });

test("reads the text layer of a PDF and labels it by page", async () => {
  const result = await extractPdfText("https://example.com/card.pdf", { fetchImpl: respond(makePdf(["Opus five behaves carefully", "Second line"])) });
  assert.equal(result.pageCount, 1);
  assert.equal(result.scanned, false);
  assert.match(result.pages[0].text, /Opus five behaves carefully/);
  assert.match(formatPdfObservationText(result, { maxBytes: 4096 }), /^\[page 1\] Opus five/);
});

test("a PDF served without a .pdf name is still read when the type says so", async () => {
  const result = await extractPdfText("https://example.com/system-card", { fetchImpl: respond(makePdf(["hello"])) });
  assert.match(result.pages[0].text, /hello/);
});

test("anything that is not a PDF is left alone", async () => {
  assert.equal(await extractPdfText("https://example.com/", { fetchImpl: respond("<html></html>", "text/html") }), null);
  assert.equal(await extractPdfText("https://example.com/x.pdf", { fetchImpl: respond("not a pdf at all") }), null, "signature is checked, not just the name");
  assert.equal(await extractPdfText("file:///etc/passwd", { fetchImpl: respond(makePdf(["x"])) }), null);
  assert.equal(await extractPdfText("https://example.com/x.pdf", { fetchImpl: async () => new Response("", { status: 404 }) }), null);
});

test("a file over the size cap is refused", async () => {
  assert.equal(await extractPdfText("https://example.com/big.pdf", { fetchImpl: respond(makePdf(["x"])), maxBytes: 100 }), null);
});

test("an image-only PDF is reported as scanned, not as empty text", async () => {
  const result = await extractPdfText("https://example.com/s.pdf", { fetchImpl: respond(makePdf([""])) });
  assert.equal(result.scanned, true);
  assert.match(formatPdfObservationText(result, { maxBytes: 4096 }), /no text layer/);
});

test("long output stops at the budget and says where", () => {
  const pages = [1, 2, 3].map((page) => ({ page, text: "word ".repeat(200).trim() }));
  const text = formatPdfObservationText({ pages, pageCount: 9, scanned: false }, { maxBytes: 2100 });
  assert.match(text, /\[page 2\]/);
  assert.doesNotMatch(text, /\[page 3\]/);
  assert.match(text, /through page 2 of 9/);
});

test("looksLikePdfUrl reads only the path", () => {
  assert.equal(looksLikePdfUrl("https://a.com/x.PDF?dl=1"), true);
  assert.equal(looksLikePdfUrl("https://a.com/pdf/x"), false);
});
