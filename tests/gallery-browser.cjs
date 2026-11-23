// Gallery interactions use synthetic previews and mocked services, never live school data.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const origin = process.env.TEST_APP_ORIGIN || "http://127.0.0.1:8000";
const watchdog = setTimeout(() => {
  console.error("Gallery checks exceeded 120 seconds");
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
  const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: "block",
    }),
    page = await ctx.newPage(),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: ({ files }) => files?.length === 1 });
    Object.defineProperty(navigator, "share", { value: async ({ files }) => {
      window.previewSharedFile = { name: files[0].name, size: files[0].size };
    } });
  });
  await page.route("**/api/**", (r) => {
    requests.push(r.request().url());
    return r.abort();
  });
  async function a11y(p) {
    await p.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const violations = await p.evaluate(async () =>
      (
        await axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          reason: n.failureSummary,
        })),
      })),
    );
    assert.deepEqual(violations, []);
  }
  async function screenshot(name) {
    if (process.env.TEST_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.TEST_SCREENSHOT_DIR, name),
        fullPage: true,
      });
    }
  }
  await page.goto(origin + "/parents?preview=1#/gallery");
  await page
    .getByRole("heading", { name: "Our colour explorers", exact: true })
    .waitFor();
  await page.locator("[data-gallery-thumb]").first().waitFor();
  await page.waitForFunction(
    () => document.querySelector("[data-gallery-thumb]")?.naturalWidth > 0,
  );
  await a11y(page);
  await screenshot("gallery-desktop.png");
  assert.equal(
    await page
      .getByRole("button", { name: "Share photos", exact: true })
      .count(),
    0,
  );
  await page.locator(".album-card").filter({ has: page.getByRole("heading", { name: "Our colour explorers", exact: true }) })
    .getByRole("button", { name: "View album", exact: true }).click();
  await page.locator("#photoStage img").waitFor();
  await page.getByText("1 of 3", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.previewSharedFile), undefined);
  await page.getByRole("button", { name: "Share photo", exact: true }).click();
  const shared = await page.evaluate(() => window.previewSharedFile);
  assert.match(shared.name, /^octominds-.*\.svg$/);
  assert.ok(shared.size > 0);
  await page.getByRole("button", { name: "Next photo", exact: true }).click();
  await page.getByText("2 of 3", { exact: true }).waitFor();
  await page.locator("#photoStage img").waitFor();
  await page.keyboard.press("ArrowRight");
  await page.getByText("3 of 3", { exact: true }).waitFor();
  await page.locator("#photoStage img").waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^octominds-.*\.svg$/);
  await a11y(page);
  await screenshot("gallery-viewer.png");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#photoStage").textContent(), "");
  await page.locator("#childSelect").selectOption({ label: "Vihaan Sharma" });
  await page
    .getByRole("heading", { name: "A story in every leaf", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Our colour explorers", exact: true })
      .count(),
    0,
  );
  await page.locator("#childSelect").selectOption({ label: "Aarohi Sharma" });
  await page.locator("#previewRole").selectOption("staff");
  await page
    .getByRole("button", { name: "Share photos", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Share photos", exact: true }).click();
  await page.locator("#albumForm [name=title]").fill("Our first photo album");
  await page
    .locator("#albumForm [name=description]")
    .fill("A happy morning at school.");
  await page.locator("#albumFiles").setInputFiles([
    {
      name: "one.png",
      mimeType: "image/png",
      buffer: await fs.readFile(
        path.join(__dirname, "fixtures/gallery-upload.png"),
      ),
    },
    {
      name: "two.png",
      mimeType: "image/png",
      buffer: await fs.readFile(
        path.join(__dirname, "fixtures/gallery-upload.png"),
      ),
    },
  ]);
  await page.locator("[data-photo-caption]").first().fill("A little discovery");
  await a11y(page);
  await screenshot("gallery-upload.png");
  await page
    .getByRole("button", { name: "Upload & publish", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Our first photo album", exact: true })
    .waitFor();
  await page.getByRole("link", { name: "School desk", exact: true }).click();
  await page.getByRole("link", { name: "Manage albums", exact: true }).click();
  await page.getByRole("heading", { name: "School albums", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Our first photo album", exact: true }).waitFor();
  await page.getByRole("link", { name: "Photo gallery", exact: true }).click();
  await page.locator("#previewRole").selectOption("parent");
  await page
    .getByRole("heading", { name: "Our first photo album", exact: true })
    .waitFor();
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Our first photo album",
        exact: true,
      }),
    })
    .locator("[data-gallery-photo]")
    .first()
    .click();
  await page.locator("#photoStage img").waitFor();
  await page.getByText("A little discovery", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Remove photo", exact: true })
      .isVisible(),
    false,
  );
  await page.keyboard.press("Escape");
  await page.locator("#previewRole").selectOption("staff");
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Our first photo album",
        exact: true,
      }),
    })
    .locator("[data-gallery-photo]")
    .first()
    .click();
  await page.locator("#photoStage img").waitFor();
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await page
    .getByRole("heading", { name: "Our first photo album", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("article")
      .filter({
        has: page.getByRole("heading", {
          name: "Our first photo album",
          exact: true,
        }),
      })
      .locator("[data-gallery-photo]")
      .count(),
    1,
  );
  await page
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "Our first photo album",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Withdraw album", exact: true })
    .click();
  await page.getByText("Album withdrawn.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Our first photo album", exact: true })
      .count(),
    0,
  );
  await page.locator("#previewRole").selectOption("parent");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Our colour explorers", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await a11y(page);
  await screenshot("gallery-mobile.png");
  assert.deepEqual(
    requests,
    [],
    "Preview images and uploads must never contact the live API",
  );
  console.log(
    "PASS: dated albums, child switching, viewer keyboard/download, uploads, captions, removal, privacy and mobile accessibility",
  );
  const live = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    }),
    p = await live.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("dialog", (d) => d.accept());
  const A = "00000000-0000-4000-8000-000000000101",
    B = "00000000-0000-4000-8000-000000000102",
    C = "00000000-0000-4000-8000-000000000103",
    AL = "00000000-0000-4000-8000-000000000104";
  let album = null,
    photos = [],
    failed = false,
    attempts = {},
    deny = false,
    slow = false;
  await p.addInitScript(() => {
    sessionStorage.setItem(
      "octominds.inventory.session",
      JSON.stringify({
        access_token: "test",
        refresh_token: "refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    window.__revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      window.__revoked.push(url);
      revoke(url);
    };
  });
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
    const req = r.request(),
      u = new URL(req.url()),
      method = req.method();
    if (u.pathname.startsWith("/api/v1/auth/")) return r.fallback();
    if (u.pathname.endsWith("/workspace"))
      return r.fulfill({
        json: {
          account: { id: "teacher", full_name: "Test Teacher", role: "teacher" },
          students: [
            {
              id: A,
              class_id: C,
              full_name: "Child A",
              can_publish: true,
              is_active: true,
            },
            {
              id: B,
              class_id: "other",
              full_name: "Child B",
              can_publish: false,
              is_active: true,
            },
          ],
          classes: [{ id: C, name: "Nursery A", center_name: "Green Park" }],
          guardians: [],
          parent_accounts: [],
        },
      });
    if (u.pathname.endsWith("/gallery/cleanup"))
      return r.fulfill({ json: { albums: [] } });
    if (u.pathname.endsWith("/gallery"))
      return r.fulfill({
        json: {
          albums: u.pathname.includes(B)
            ? []
            : album
              ? [{ ...album, photos }]
              : [],
          total: album ? 1 : 0,
          page: 1,
          page_size: 12,
        },
      });
    if (u.pathname.endsWith("/albums") && method === "POST") {
      album = {
        ...req.postDataJSON(),
        id: AL,
        status: "draft",
        can_manage: true,
      };
      return r.fulfill({ status: 201, json: album });
    }
    if (u.pathname.includes("/photos/") && u.pathname.endsWith("/image")) {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 400));
      return deny
        ? r.fulfill({
            status: 403,
            json: { detail: "Photo access is not assigned" },
          })
        : r.fulfill({
            contentType: "image/png",
            body: await fs.readFile(
              path.join(__dirname, "fixtures/gallery-upload.png"),
            ),
          });
    }
    if (
      u.pathname.includes("/albums/") &&
      u.pathname.includes("/photos/") &&
      method === "POST"
    ) {
      const id = u.pathname.split("/").at(-1);
      attempts[id] = (attempts[id] || 0) + 1;
      assert.equal(
        req.postDataBuffer().subarray(1, 4).toString(),
        "PNG",
        "Upload must send raw image bytes",
      );
      if (Object.keys(attempts).length === 2 && !failed) {
        failed = true;
        return r.fulfill({
          status: 503,
          json: { detail: "Upload interrupted. Try again." },
        });
      }
      if (!photos.some((x) => x.id === id))
        photos.push({
          id,
          caption: decodeURIComponent(req.headers()["x-photo-caption"] || ""),
          status: "ready",
        });
      return r.fulfill({ status: 201, json: { id, status: "ready" } });
    }
    if (u.pathname.endsWith("/publish")) {
      album.status = "published";
      return r.fulfill({ json: { id: AL } });
    }
    return r.fulfill({
      status: 404,
      json: { detail: "Unexpected fixture request" },
    });
  });
  await p.goto(origin + "/parents#/gallery");
  await p.getByRole("button", { name: "Share photos", exact: true }).click();
  await p.locator("#albumForm [name=title]").fill("Retry album");
  await p.locator("#albumFiles").setInputFiles([
    {
      name: "a.png",
      mimeType: "image/png",
      buffer: await fs.readFile(
        path.join(__dirname, "fixtures/gallery-upload.png"),
      ),
    },
    {
      name: "b.png",
      mimeType: "image/png",
      buffer: await fs.readFile(
        path.join(__dirname, "fixtures/gallery-upload.png"),
      ),
    },
  ]);
  await p
    .getByRole("button", { name: "Upload & publish", exact: true })
    .click();
  await p
    .getByText("Upload interrupted. Try again.", { exact: true })
    .waitFor();
  assert.equal(album.status, "draft");
  await p.getByRole("button", { name: "Retry & publish", exact: true }).click();
  await p.getByRole("heading", { name: "Retry album", exact: true }).waitFor();
  assert.deepEqual(Object.values(attempts), [1, 2]);
  assert.equal(album.status, "published");
  deny = true;
  await p.locator("[data-gallery-photo]").first().click();
  await p.getByText("Photo access is not assigned", { exact: true }).waitFor();
  assert.equal(await p.locator("#photoStage img").count(), 0);
  await p
    .getByRole("button", { name: "Close photo viewer", exact: true })
    .click();
  deny = false;
  slow = true;
  await p.locator("[data-gallery-photo]").first().click();
  await p
    .getByRole("button", { name: "Close photo viewer", exact: true })
    .click();
  await p.locator("#childSelect").selectOption(B);
  await p
    .getByRole("heading", {
      name: "Little moments are on their way.",
      exact: true,
    })
    .waitFor();
  await p.waitForTimeout(500);
  assert.equal(await p.locator("#photoStage img").count(), 0);
  assert.equal(await p.locator("[data-gallery-thumb]").count(), 0);
  assert.ok(
    (await p.evaluate(() => window.__revoked)).length > 0,
    "Child switch revokes transient image URLs",
  );
  await p.getByRole("button", { name: "Sign out", exact: true }).click();
  await p.locator("#loginForm").waitFor();
  assert.equal(await p.locator("#photoStage").textContent(), "");
  assert.deepEqual(errors, []);
  clearTimeout(watchdog);
  await browser.close();
  console.log(
    "PASS: partial upload retry without duplicates, auth-denied image, stale image response, child switch URL cleanup, logout",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
