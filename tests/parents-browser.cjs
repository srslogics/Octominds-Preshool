// Synthetic parent/staff workflows and mocked authentication; no live school writes.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const origin = process.env.TEST_APP_ORIGIN || "http://127.0.0.1:8000";
const watchdog = setTimeout(() => {
  console.error("Parent browser checks exceeded 120 seconds");
  process.exit(1);
}, 120000);
watchdog.unref();
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  const page = await context.newPage(),
    errors = [],
    apiRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.route("**/api/**", (r) => {
    apiRequests.push(r.request().url());
    return r.abort();
  });
  async function nav(name) {
    await page
      .getByRole("navigation")
      .getByRole("link", { name, exact: true })
      .click();
  }
  async function visible(text) {
    await page
      .getByText(text, { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();
  }
  async function a11y(target = page) {
    await target.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const issues = await target.evaluate(async () =>
      (
        await axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    );
    assert.deepEqual(issues, []);
  }
  async function noOverflow() {
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  await page.goto(origin + "/parents?preview=1#/today");
  await visible("The latest little moments");
  assert.equal(await page.locator("#childSelect option").count(), 2);
  assert.equal(
    await page.getByRole("navigation").getByText("School desk").count(),
    0,
  );
  await a11y();
  await noOverflow();
  const screenshotDir = process.env.TEST_SCREENSHOT_DIR;
  if (screenshotDir) {
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "parents-desktop.png"),
      fullPage: true,
    });
  }
  await nav("Home learning");
  await visible("A little counting adventure");
  await page.locator("#childSelect").selectOption({ label: "Vihaan Sharma" });
  await visible("Bring a story to share");
  assert.equal(
    await page
      .getByText("A little counting adventure", { exact: true })
      .count(),
    0,
  );
  await nav("Daily diary");
  await visible("Nothing shared here yet.");
  await nav("My child");
  await visible("Kindergarten B · 2026–27");
  await page.locator("#childSelect").selectOption({ label: "Aarohi Sharma" });
  await nav("Ask the school");
  await page
    .getByLabel("Your message")
    .fill('<img src=x onerror="window.__injected=1"> Hello from home');
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await visible('<img src=x onerror="window.__injected=1"> Hello from home');
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await nav("Calendar");
  await a11y();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: "Previous month" }).click();
  await page.locator("#previewRole").selectOption("staff");
  await nav("School desk");
  await visible("Children & family connections");
  await page
    .getByRole("button", { name: "Register a child", exact: false })
    .click();
  await page.getByLabel("Child’s full name").fill("New Little Learner");
  await page.getByRole("button", { name: "Save child", exact: true }).click();
  await visible("New Little Learner");
  await page
    .getByRole("button", { name: "Connect a family", exact: false })
    .click();
  await page
    .locator("#editorForm [name=student_id]")
    .selectOption({ label: "New Little Learner · Nursery A" });
  await page
    .locator("#editorForm [name=user_id]")
    .selectOption({ label: "Ananya Sharma · ananya@example.invalid" });
  await page.getByLabel("Relationship", { exact: true }).fill("Guardian");
  await page
    .getByRole("button", { name: "Connect parent", exact: true })
    .click();
  await visible("Family access connected.");
  await page
    .getByRole("button", { name: "Share an update", exact: false })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Our first family update");
  await page
    .getByLabel("Message", { exact: true })
    .fill("A happy discovery from school.");
  await page
    .getByRole("button", { name: "Publish update", exact: true })
    .click();
  await visible("Your update is shared with families.");
  console.log("PASS: staff registration, linking and publishing");
  await page.locator("#previewRole").selectOption("parent");
  assert.equal(await page.locator("#childSelect option").count(), 3);
  await nav("School updates");
  await visible("Our first family update");
  await page.locator("#previewRole").selectOption("staff");
  await nav("School updates");
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Our first family update",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Withdraw" })
    .click();
  await visible("Update withdrawn.");
  assert.equal(
    await page
      .getByRole("heading", { name: "Our first family update", exact: true })
      .count(),
    0,
  );
  await nav("School desk");
  await page
    .locator(".student-row")
    .filter({
      has: page.getByRole("heading", {
        name: "New Little Learner",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Family access" })
    .click();
  await page.getByRole("button", { name: "Revoke access" }).click();
  await visible("Family access revoked.");
  await page.locator("#previewRole").selectOption("parent");
  assert.equal(await page.locator("#childSelect option").count(), 2);
  console.log("PASS: publication and access revocation");
  await page.goto(origin + "/parents?preview=1#/today");
  await visible("The latest little moments");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Today");
  await visible("The latest little moments");
  await noOverflow();
  await a11y();
  if (screenshotDir)
    await page.screenshot({
      path: path.join(screenshotDir, "parents-mobile.png"),
      fullPage: true,
    });
  for (const name of [
    "Home learning",
    "Daily diary",
    "Calendar",
    "Ask the school",
    "My child",
  ]) {
    await nav(name);
    await noOverflow();
    await a11y();
  }
  console.log("PASS: mobile and accessibility");
  assert.deepEqual(
    apiRequests,
    [],
    "Preview must never read or write the live API",
  );
  assert.deepEqual(errors, []);
  // Live-mode outage, late child responses, and logout must never reveal preview data or previous-child data.
  const live = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    serviceWorkers: "block",
  });
  const p = await live.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  const A = "00000000-0000-4000-8000-000000000101",
    B = "00000000-0000-4000-8000-000000000102";
  let fail = true,
    hold = false;
  await p.addInitScript(() =>
    sessionStorage.setItem(
      "octominds.inventory.session",
      JSON.stringify({
        access_token: "test",
        refresh_token: "refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  await p.route("**/config.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: "window.OCTOMINDS_CONFIG={}",
    }),
  );
  await p.route("**/api/v1/auth/**", (r) =>
    r.fulfill({ json: {} }),
  );
  await p.route("**/api/v1/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith("/api/v1/auth/")) return r.fallback();
    if (u.pathname === "/api/v1/session")
      return r.fulfill({
        json: { id: "parent", full_name: "Test Parent", role: "parent" },
      });
    if (u.pathname.endsWith("/workspace"))
      return r.fulfill({
        json: {
          students: [
            {
              id: A,
              full_name: "Child A",
              class_name: "Nursery",
              center_name: "Green Park",
              year_name: "2026",
              is_active: true,
            },
            {
              id: B,
              full_name: "Child B",
              class_name: "KG",
              center_name: "Green Park",
              year_name: "2026",
              is_active: true,
            },
          ],
          classes: [],
          guardians: [],
          parent_accounts: [],
        },
      });
    if (fail)
      return r.fulfill({
        status: 503,
        json: { detail: "School is temporarily unavailable" },
      });
    const child = u.pathname.includes(A) ? "A" : "B";
    if (hold && child === "A")
      await new Promise((resolve) => setTimeout(resolve, 400));
    return r.fulfill({
      json: {
        posts: [
          {
            id: child,
            kind: "notice",
            title: "Only child " + child,
            body: "Private child update",
            created_at: new Date().toISOString(),
            author_name: "School",
          },
        ],
        total: 1,
        page: 1,
        page_size: 20,
      },
    });
  });
  await p.goto(origin + "/parents#/updates");
  await p
    .getByRole("heading", { name: "We couldn’t load this just now." })
    .waitFor();
  assert.equal(await p.getByText("Aarohi Sharma").count(), 0);
  assert.equal(await p.locator("#previewBanner").isVisible(), false);
  fail = false;
  await p.getByRole("button", { name: "Try again" }).click();
  await p.getByRole("heading", { name: "Only child A", exact: true }).waitFor();
  console.log("PASS: outage and retry");
  hold = true;
  const delayed = p.waitForRequest((r) => r.url().includes(A + "/posts"));
  await p.getByRole("button", { name: "Refresh updates", exact: true }).click();
  await delayed;
  await p.locator("#childSelect").selectOption(B);
  await p.getByRole("heading", { name: "Only child B", exact: true }).waitFor();
  await p.waitForTimeout(500);
  assert.equal(
    await p.getByRole("heading", { name: "Only child A", exact: true }).count(),
    0,
  );
  await p.getByRole("button", { name: "Sign out", exact: true }).click();
  await p.locator("#loginForm").waitFor();
  assert.equal(await p.locator("#content").textContent(), "");
  assert.equal(
    await p.evaluate(() =>
      sessionStorage.getItem("octominds.inventory.session"),
    ),
    null,
  );
  await a11y(p);
  assert.deepEqual(errors, []);
  clearTimeout(watchdog);
  await browser.close();
  console.log(
    "Parent browser checks passed: parent/staff workflows, child switching, publishing, linking/revocation, messages, calendar, mobile, accessibility, outages and stale responses.",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
