const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireCdpBrowser, findChromium } = require('../main/harness/cdp-browser-host');
const { openCdpView } = require('../main/harness/cdp-web-contents');
const { dispatchBrowserInput } = require('../main/harness/browser-input');

test('human wheel down scrolls Chromium down through the shared Electron input contract', { skip: !findChromium(), timeout: 25000 }, async () => {
  const browser = await acquireCdpBrowser({ headless: true, startupTimeoutMs: 15000 });
  let view;
  try {
    view = await openCdpView(browser.wsUrl, { width: 900, height: 600, commandTimeoutMs: 5000 });
    const wc = view.webContents;
    await wc.loadURL('about:blank');
    await wc.executeJavaScript('document.body.innerHTML = "<input id=entry style=position:fixed;left:20px;top:20px;width:300px;height:40px><div style=height:5000px>Scroll fixture</div>"');
    dispatchBrowserInput(wc, view.getBounds(), { type: 'mouseDown', nx: 0.1, ny: 0.05, button: 'left' });
    dispatchBrowserInput(wc, view.getBounds(), { type: 'mouseUp', nx: 0.1, ny: 0.05, button: 'left' });
    // Await a command on the same transport before checking the focused element.
    assert.equal(await wc.executeJavaScript('document.activeElement.id'), 'entry');
    dispatchBrowserInput(wc, view.getBounds(), { type: 'insertText', text: 'Halo 한글' });
    assert.equal(await wc.executeJavaScript('document.getElementById("entry").value'), 'Halo 한글');
    // RemotePageFrame converts DOM wheel +300 into Electron wheel -300.
    assert.equal(dispatchBrowserInput(wc, view.getBounds(), { type: 'mouseWheel', nx: 0.5, ny: 0.5, deltaX: 0, deltaY: -300 }), true);
    let scrollY = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && scrollY === 0) {
      await new Promise(resolve => setTimeout(resolve, 30));
      scrollY = await wc.executeJavaScript('window.scrollY');
    }
    assert.ok(scrollY > 0, `downward wheel must move down, got ${scrollY}`);
    dispatchBrowserInput(wc, view.getBounds(), { type: 'mouseWheel', nx: 0.5, ny: 0.5, deltaX: 0, deltaY: 300 });
    const upDeadline = Date.now() + 1500;
    let after = scrollY;
    while (Date.now() < upDeadline && after >= scrollY) {
      await new Promise(resolve => setTimeout(resolve, 30));
      after = await wc.executeJavaScript('window.scrollY');
    }
    assert.ok(after < scrollY, 'upward wheel must move back up');
  } finally { view?.closeConnection(); await browser.close(); }
});
