"use strict";

// Developer-only localhost smoke: every Halowright op against a real Chromium page. No models or external sites.
const http = require("node:http");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { runHwStep } = require("../main/harness/halowright");

const PAGE = `<title>t</title><style>body{margin:0}#spacer{height:3000px}</style>
<label>Agree <input type=checkbox id=ag onchange="document.title='ag'+this.checked"></label>
<label>Country <select id=c onchange="document.title='c-'+this.value"><option value=us>United States</option><option value=kr>Korea</option></select></label>
<button id=h onmouseover="document.title='hovered'">Menu</button>
<input id=e placeholder="Query" onkeydown="if(event.key==='Enter')document.title='entered'">
<section id=a><h3>Billing</h3><button onclick="document.title='bill'">Save</button></section>
<section id=b><h3>Profile</h3><button onclick="document.title='prof'">Save</button></section>
<my-card></my-card>
<script>customElements.define('my-card',class extends HTMLElement{connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<button id=sb>Shadow Go</button><input placeholder="Inside">';this.shadowRoot.getElementById('sb').onclick=()=>{document.title='shadow'}}})</script>
<div id=spacer></div>`;

async function main() {
  const server = http.createServer((_q: any, r: any) => { r.setHeader("content-type", "text/html"); r.end(PAGE); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", ...(process.env.HALO_CHROMIUM ? { chromiumPath: process.env.HALO_CHROMIUM } : {}) });
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  try {
    const wc = engine.createPage("halo-task-ops-smoke").webContents;
    await wc.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const title = async () => (await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "document.title" }]));
    const run = (step: any) => runHwStep(wc, step, { sleep, authorize: () => true });
    const rows: any[] = [];
    const record = async (name: string, step: any, expectTitle?: string, expectError?: string) => {
      const result = await run(step);
      const got = await title();
      rows.push({ name, status: result.status, errorCode: result.errorCode, title: got, pass: expectError ? result.errorCode === expectError : result.status === "ok" && (expectTitle === undefined || got === expectTitle) });
    };
    await record("check", { op: "check", locator: { label: "Agree" } }, "agtrue");
    await record("check-again-idempotent", { op: "check", locator: { label: "Agree" } }, "agtrue");
    await record("uncheck", { op: "uncheck", locator: { label: "Agree" } }, "agfalse");
    await record("select", { op: "select", locator: { label: "Country" }, value: "Korea" }, "c-kr");
    await record("hover", { op: "hover", locator: { role: "button", name: "Menu" } }, "hovered");
    await record("fill+press", { op: "fill", locator: { placeholder: "Query" }, text: "hi" });
    await record("press-enter", { op: "press", key: "Enter" }, "entered");
    await record("within-ambiguous-without-scope", { op: "click", locator: { role: "button", name: "Save" } }, undefined, "locator_ambiguous");
    await record("within", { op: "click", locator: { role: "button", name: "Save", within: { text: "Profile" } } }, "prof");
    await record("shadow-click", { op: "click", locator: { role: "button", name: "Shadow Go" } }, "shadow");
    await record("shadow-fill", { op: "fill", locator: { placeholder: "Inside" }, text: "yo" });
    await record("scroll", { op: "scroll", dy: 800 });
    const y = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "Math.round(scrollY)" }]);
    rows.push({ name: "scrollY>0", pass: y > 0, y });
    process.stdout.write(JSON.stringify(rows, null, 1) + "\n");
    if (rows.some(r => !r.pass)) process.exitCode = 1;
  } finally {
    await engine.release();
    await new Promise<void>(resolve => server.close(resolve));
  }
}
void main().catch((error: Error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
