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
  const screenshotDir = process.env.TEST_SCREENSHOT_DIR;
  await page.goto(origin + "/parents");
  await page.getByRole("heading", { name: "Welcome to Family Portal" }).waitFor();
  async function signInFillsViewport() {
    const bounds = await page.locator(".auth-shell").evaluate((shell) => {
      const { top, left, right, bottom } = shell.getBoundingClientRect();
      return { top, left, right, bottom, width: innerWidth, height: innerHeight };
    });
    assert.equal(bounds.top, 0);
    assert.equal(bounds.left, 0);
    assert.equal(bounds.right, bounds.width);
    assert.ok(bounds.bottom >= bounds.height);
  }
  await signInFillsViewport();
  assert.equal(await page.locator("#remember").isChecked(), false);
  assert.equal(await page.getByRole("link", { name: /Need help signing in/ }).getAttribute("href"), "/school");
  if (screenshotDir) {
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "parents-sign-in-desktop.png") });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await signInFillsViewport();
  if (screenshotDir) {
    await page.screenshot({ path: path.join(screenshotDir, "parents-sign-in-phone.png"), fullPage: true });
  }
  const password = page.getByLabel("Password or 6-digit PIN");
  await password.fill("preview-password");
  await page.getByRole("button", { name: "Show password or PIN" }).click();
  assert.equal(await password.getAttribute("type"), "text");
  await page.getByRole("button", { name: "Hide password or PIN" }).click();
  assert.equal(await password.getAttribute("type"), "password");
  assert.equal(await password.inputValue(), "preview-password");
  await password.clear();
  await a11y();
  await noOverflow();
  await page.getByRole("link", { name: /guest preview/i }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log("PASS: mobile sign-in layout, password visibility, and guest preview link");
  await page.getByRole("heading", { name: "Little Moments Captured", exact: true }).waitFor();
  await visible("Finger Painting: Spring Blossoms");
  await page.getByText("Currently: Nap & Quiet Rest").waitFor();
  await page.getByRole("link", { name: /View sample album/ }).click();
  await page.getByRole("heading", { name: "Our colour explorers", exact: true }).waitFor();
  await nav("Today");
  await page.getByText("Full menu plan").click();
  await visible("Lunch: Paneer khichdi with sweet papaya.");
  await page.getByRole("link", { name: "Running late", exact: true }).click();
  const late = page.getByLabel("Your message");
  await late.waitFor();
  assert.match(await late.inputValue(), /Aarohi Sharma will be arriving late today/);
  assert.equal(await page.locator(".thread").getByText(/will be arriving late today/).count(), 0);
  await nav("Today");
  await page.getByLabel("Switch child").selectOption({ label: "Vihaan Sharma" });
  await page.getByRole("link", { name: "Report absent", exact: true }).click();
  const absent = page.getByLabel("Your message");
  await absent.waitFor();
  assert.match(await absent.inputValue(), /Vihaan Sharma will be absent today/);
  await nav("Today");
  await page.getByLabel("Switch child").selectOption({ label: "Aarohi Sharma" });
  assert.equal(await page.locator("#childSelect option").count(), 2);
  assert.equal(
    await page.getByRole("navigation").getByText("School desk").count(),
    0,
  );
  await a11y();
  await noOverflow();
  if (screenshotDir) {
    await fs.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, "parents-desktop.png"),
      fullPage: true,
    });
  }
  await nav("Home learning");
  await page.getByRole("heading", { name: "A little counting adventure", exact: true }).waitFor();
  await page.getByRole("heading", { name: /The Great Sock Matching Game/ }).waitFor();
  const rhyme = page.locator(".learning-rhyme audio");
  await rhyme.evaluate(audio => { audio.preload = "metadata"; audio.load(); });
  await page.waitForFunction(() => document.querySelector(".learning-rhyme audio")?.duration > 0);
  await page.locator(".learning-card.featured").getByRole("link", { name: "Share with the school", exact: true }).click();
  assert.match(await page.getByLabel("Your message").inputValue(), /Sock Matching Game/);
  await nav("School updates");
  const acknowledge = page.getByRole("button", { name: "Acknowledge", exact: true });
  await acknowledge.click();
  assert.equal(await page.getByRole("button", { name: "✓ Acknowledged", exact: true }).isDisabled(), true);
  await nav("Daily diary");
  await page.getByRole("heading", { name: "Lunch & Nutrition Log", exact: true }).waitFor();
  await visible("2 cups");
  await nav("Home learning");
  await page.locator("#childSelect").selectOption({ label: "Vihaan Sharma" });
  await page.getByRole("heading", { name: "Bring a story to share", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "A little counting adventure", exact: true })
      .count(),
    0,
  );
  await nav("Daily diary");
  await visible("Nothing shared here yet.");
  await nav("My child");
  await page.locator(".child-class").getByText("Story Builders (Kindergarten B)").waitFor();
  await page.getByLabel("Switch child").selectOption({ label: "Aarohi Sharma" });
  await page.getByText("No known allergies").waitFor();
  await visible("Little Picasso");
  await page.getByRole("heading", { name: "Authorized Pickups", exact: true }).waitFor();
  await page.getByRole("heading", { name: /Gate Pickup Pass/ }).waitFor();
  await nav("Ask the school");
  await page.getByRole("button", { name: "Medicine note", exact: true }).click();
  assert.match(await page.getByLabel("Your message").inputValue(), /care note for Aarohi Sharma/);
  assert.equal(await page.getByRole("button", { name: "Medicine / diet", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Class teacher", exact: true }).click();
  await page
    .getByLabel("Your message")
    .fill('<img src=x onerror="window.__injected=1"> Hello from home');
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await visible('<img src=x onerror="window.__injected=1"> Hello from home');
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await nav("Calendar");
  await page.getByRole("heading", { name: "School Calendar", exact: true }).waitFor();
  await visible("Parent prep checklist");
  await page.getByRole("button", { name: "PTM Connect", exact: true }).click();
  assert.equal(await page.locator(".calendar-agenda-card").count(), 1);
  await visible("Parent–Teacher Connect");
  await page.getByRole("button", { name: /^All \(/ }).click();
  await page.getByRole("button", { name: "Holidays", exact: true }).click();
  await visible("Winter Break · School Closed");
  await page.getByRole("button", { name: /^All \(/ }).click();
  await page.locator(".calendar-week-day[aria-current=date]").click();
  await visible("Regular School Day · Routine Play");
  assert.equal(await page.locator(".calendar-agenda-card").count(), 1);
  await page.getByRole("button", { name: "Show all dates", exact: true }).click();
  assert.equal(await page.locator(".calendar-agenda-card").count(), 5);
  async function calendarDownload(name) {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name, exact: true }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^octominds-sample-(?:calendar|reminder)-.*\.ics$/);
    const data = await fs.readFile(await file.path(), "utf8");
    assert.ok(data.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(data.split("\r\n").every(line => Buffer.byteLength(line) <= 75));
    return data.replace(/\r\n /g, "");
  }
  const reminder = await calendarDownload("Add 1-day reminder");
  assert.match(reminder, /BEGIN:VALARM\r\nTRIGGER:-P1D/);
  assert.match(reminder, /SUMMARY:Sample: Yellow Sunshine Day/);
  const monthExport = await calendarDownload("Export calendar");
  assert.equal((monthExport.match(/BEGIN:VEVENT/g) || []).length, 5);
  assert.doesNotMatch(monthExport, /BEGIN:VALARM/);
  await a11y();
  await page.getByRole("button", { name: "Next month" }).click();
  await page.getByRole("button", { name: "Previous month" }).click();
  await page.getByRole("button", { name: "Next week", exact: true }).click();
  await page.getByRole("button", { name: "Previous week", exact: true }).click();
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
  await page.getByRole("heading", { name: "Our first family update", exact: true }).waitFor();
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
  await page.getByRole("heading", { name: "Little Moments Captured", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await nav("Today");
  await page.getByRole("heading", { name: "Little Moments Captured", exact: true }).waitFor();
  const mobileNav = page.getByRole("navigation", { name: "Main navigation" });
  assert.equal(await mobileNav.getByRole("link").count(), 8);
  assert.ok(await mobileNav.evaluate((nav) => nav.scrollWidth <= nav.clientWidth));
  assert.equal(await mobileNav.getByRole("link", { name: "Today" }).getAttribute("aria-current"), "page");
  await noOverflow();
  await a11y();
  if (screenshotDir)
    await page.screenshot({
      path: path.join(screenshotDir, "parents-mobile.png"),
      fullPage: true,
    });
  for (const name of [
    "School updates",
    "Home learning",
    "Daily diary",
    "Calendar",
    "Photo gallery",
    "Ask the school",
    "My child",
  ]) {
    await nav(name);
    await page.locator("#content .loading").waitFor({ state: "hidden" });
    await noOverflow();
    await a11y();
  }
  if (screenshotDir)
    await page.screenshot({
      path: path.join(screenshotDir, "parents-my-child-mobile.png"),
      fullPage: true,
    });
  await page.locator("#childBack").click();
  await page.getByRole("heading", { name: "Little Moments Captured", exact: true }).waitFor();
  await page.locator("#previewRole").selectOption("staff");
  await nav("School desk");
  await visible("Children & family connections");
  await noOverflow();
  await a11y();
  await page.getByRole("link", { name: "Manage albums", exact: true }).click();
  await page.getByRole("heading", { name: "School albums", exact: true }).waitFor();
  assert.equal(await page.locator("#childBack").getAttribute("href"), "/parents?preview=1#/manage");
  await page.locator("#content .loading").waitFor({ state: "hidden" });
  await noOverflow();
  await a11y();
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
    if (u.pathname.endsWith("/workspace"))
      return r.fulfill({
        json: {
          account: { id: "parent", full_name: "Test Parent", role: "parent" },
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
    if (u.pathname.endsWith("/calendar")) return r.fulfill({ json: { events: [], holidays: [] } });
    if (u.pathname.endsWith("/profile"))
      return r.fulfill({
        json: { team: [{ full_name: "Teacher " + child, role: "Class teacher" }], office_phone: "+91 1234567890" },
      });
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
  await p.getByRole("navigation").getByRole("link", { name: "My child", exact: true }).click();
  await p.getByRole("heading", { name: "Teacher B", exact: true }).waitFor();
  assert.equal(await p.getByText("No known allergies").count(), 0);
  assert.equal(await p.getByText("Gate Pickup Pass").count(), 0);
  assert.equal(await p.getByRole("link", { name: "Call school", exact: true }).getAttribute("href"), "tel:+911234567890");
  await a11y(p);
  await p.locator("#childBack").click();
  await p.getByRole("heading", { name: "Only child B", exact: true }).waitFor();
  assert.equal(await p.getByText("Sample menu", { exact: true }).count(), 0);
  assert.equal(await p.getByText("Nap & Quiet Rest").count(), 0);
  assert.equal(await p.getByRole("link", { name: "Gate pass", exact: true }).count(), 0);
  await a11y(p);
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
