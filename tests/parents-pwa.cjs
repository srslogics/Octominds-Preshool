const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const origin = process.env.TEST_APP_ORIGIN || "http://127.0.0.1:4198";

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      window.addEventListener("beforeinstallprompt", (event) => {
        if (event.isTrusted) event.stopImmediatePropagation();
      }, { capture: true });
    });
    await page.goto(origin + "/parents");
    const install = page.getByRole("button", { name: "Install Family Portal", exact: true });
    await install.waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    assert.equal(manifest.url, origin + "/parents.webmanifest");
    assert.deepEqual(manifest.errors, []);
    const { id, start_url: start, scope, display } = JSON.parse(manifest.data);
    assert.deepEqual({ id, start, scope, display }, { id: "/parents", start: "/parents", scope: "/parents", display: "standalone" });

    const eligibility = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(eligibility.installabilityErrors, []);
    console.log("PASS: Chromium recognizes the standalone Parent Portal manifest");

    await install.click();
    await page.getByRole("dialog", { name: "Install Family Portal" }).waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = async () => { window.installRequested = true; };
      event.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(event);
    });
    await install.click();
    await page.waitForFunction(() => window.installRequested);
    await install.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await install.waitFor({ state: "hidden" });
    console.log("PASS: the install action uses the saved browser prompt and hides after installation");

    await page.evaluate(async () => {
      await fetch("/api/v1/parents/workspace");
      await fetch("/config.js");
    });
    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await page.reload();
    assert.equal(await page.locator("body").getAttribute("data-offline-launch"), "");
    await page.getByText("You’re offline. Reconnect to sign in or get school updates.", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Welcome to Family Portal" }).waitFor();
    const cached = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find(name => name.startsWith("octominds-apps-")));
      return (await cache.keys()).map(request => new URL(request.url).pathname);
    });
    assert.ok(cached.includes("/parents"));
    assert.ok(cached.includes("/parents.webmanifest"));
    assert.ok(!cached.some(path => path.startsWith("/api/") || path === "/config.js"));
    await page.getByLabel("Email or mobile number").fill("parent@example.test");
    await page.locator("#password").fill("test-passphrase");
    await page.getByRole("button", { name: /sign in to school portal/i }).click();
    await page.getByText("Reconnect to sign in.", { exact: true }).waitFor();
    await context.setOffline(false);
    if (await page.locator("#retryPortal").isVisible()) await page.locator("#retryPortal").click();
    await page.locator("#offlineNotice").waitFor({ state: "hidden" });
    console.log("PASS: offline launch uses the public shell and keeps private requests out of the cache");

    const phone = await browser.newContext({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const mobile = await phone.newPage();
    await mobile.goto(origin + "/parents");
    await mobile.getByRole("button", { name: "Install Family Portal", exact: true }).click();
    await mobile.getByText(/tap Add to Home Screen/).waitFor();
    await mobile.getByRole("button", { name: "Done", exact: true }).click();
    await mobile.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
    await mobile.reload();
    assert.equal(await mobile.getByRole("button", { name: "Install Family Portal", exact: true }).count(), 0);
    console.log("PASS: iPhone guidance is shown in the browser and hidden in standalone mode");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
