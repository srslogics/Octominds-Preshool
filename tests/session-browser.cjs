// Deliberately delay authentication responses to exercise session races across apps.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const origin = process.env.TEST_APP_ORIGIN || 'http://127.0.0.1:4180';
const key = 'octominds.inventory.session';

function gate() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  return { pending, release };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const owner = { id: 'owner', full_name: 'Test Owner', role: 'super_admin' };
    const parent = { id: 'parent', full_name: 'Test Parent', role: 'parent' };
    const accounts = new Map();
    const revocations = [];
    const errors = [];
    let sequence = 0, renewals = 0, blockedLogout, blockedWorkspace, blockedRefresh;
    let deniedWorkspaceToken;
    function issue(account) {
      const number = ++sequence;
      const token = { access_token: `access-${number}`, refresh_token: `refresh-${number}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600 };
      accounts.set(token.access_token, { account, token });
      return token;
    }
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/api/v1/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const access = request.headers().authorization?.slice('Bearer '.length);
      const account = accounts.get(access)?.account;
      if (url.pathname.endsWith('/auth/logout')) {
        revocations.push(access);
        const hold = blockedLogout;
        if (hold) await hold.pending;
        accounts.delete(access);
        return route.fulfill({ status: 204 });
      }
      if (url.pathname.endsWith('/auth/token')) {
        const body = request.postDataJSON();
        if (url.searchParams.get('grant_type') === 'password') {
          return route.fulfill({ json: issue(body.email.endsWith('@auth.octominds.invalid') ? parent : owner) });
        }
        renewals++;
        const current = [...accounts.values()].find(entry => entry.token.refresh_token === body.refresh_token);
        const hold = blockedRefresh;
        if (hold) await hold.pending;
        if (!current || !accounts.delete(current.token.access_token)) {
          return route.fulfill({ status: 401, json: { detail: 'Invalid refresh token' } });
        }
        return route.fulfill({ json: issue(current.account) });
      }
      if (url.pathname.endsWith('/school/workspace') && blockedWorkspace) {
        const hold = blockedWorkspace;
        blockedWorkspace = null;
        await hold.pending;
        return route.fulfill({ status: 401, json: { detail: 'Old session expired' } });
      }
      if (access && access === deniedWorkspaceToken) return route.fulfill({ status: 401 });
      if (!account) return route.fulfill({ status: 401, json: { detail: 'Invalid access token' } });
      if (url.pathname.endsWith('/school/workspace')) return route.fulfill({ json: {
        account, school: [], centers: [], years: [], terms: [], programs: [],
        classes: [], assignments: [], holidays: [], memberships: [],
      } });
      if (url.pathname.endsWith('/parents/workspace')) return route.fulfill({ json: { account, classes: [], students: [] } });
      return route.fulfill({ status: 404 });
    });

    async function signIn(page, login, remember = false) {
      await page.locator('#identity').fill(login);
      await page.locator('#password').fill(login.includes('@') ? 'valid-test-password' : '123456');
      if (remember) await page.locator('#remember').check();
      await page.locator('#auth button[type="submit"]:visible').click();
    }
    const school = await context.newPage();
    const family = await context.newPage();
    await Promise.all([school.goto(origin + '/school'), family.goto(origin + '/parents')]);
    await signIn(school, 'owner@example.test', true);
    await signIn(family, '9876543210');
    await school.locator('#workspace').waitFor();
    await family.locator('#portal').waitFor();
    assert.equal(await family.locator('#accountName').textContent(), 'Test Parent');

    blockedLogout = gate();
    const oldWorkspace = blockedWorkspace = gate();
    const workspaceRequest = school.waitForRequest('**/api/v1/school/workspace?*');
    await school.locator('[data-action="reload"]').click();
    await workspaceRequest;
    await school.locator('#signOut').click();
    await school.locator('#signInForm').waitFor({ timeout: 3000 });
    assert.equal(await school.locator('#content').textContent(), '');
    await signIn(school, 'owner@example.test', true);
    await school.locator('#workspace').waitFor();
    const oldResponse = school.waitForResponse(response => response.status() === 401);
    oldWorkspace.release();
    await oldResponse;
    blockedLogout.release();
    blockedLogout = null;
    assert.equal(await school.locator('#userName').textContent(), 'Test Owner');
    assert.equal(await family.locator('#portal').isVisible(), true);
    assert.equal(renewals, 0);
    console.log('PASS: slow sign-out and a delayed 401 leave the new login and the other account intact');

    await family.locator('#signOut').click();
    await family.reload();
    await family.locator('#loginForm').waitFor();
    assert.equal(await school.locator('#workspace').isVisible(), true);
    const restored = await context.newPage();
    await restored.goto(origin + '/parents');
    await restored.locator('#portal').waitFor();
    assert.equal(await restored.locator('#accountName').textContent(), 'Test Owner');
    console.log('PASS: a signed-out tab stays signed out while an unrelated remembered account is preserved');

    await school.evaluate((storageKey) => {
      const value = JSON.parse(localStorage.getItem(storageKey));
      value.expires_at = 1;
      localStorage.setItem(storageKey, JSON.stringify(value));
    }, key);
    blockedRefresh = gate();
    const schoolRestored = await context.newPage();
    const familyRestored = await context.newPage();
    await Promise.all([schoolRestored.goto(origin + '/school'), familyRestored.goto(origin + '/parents')]);
    await schoolRestored.getByText('Checking your saved session…').waitFor();
    await familyRestored.getByText('Checking your saved session…').waitFor();
    blockedRefresh.release();
    blockedRefresh = null;
    await schoolRestored.locator('#workspace').waitFor();
    await familyRestored.locator('#portal').waitFor();
    assert.equal(renewals, 1);
    const refreshedToken = await schoolRestored.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)).access_token, key);
    const revocation = school.waitForResponse(response =>
      response.url().includes('/auth/logout') && response.request().headers().authorization === 'Bearer ' + refreshedToken);
    await school.locator('#signOut').click();
    await Promise.all([
      schoolRestored.locator('#signInForm').waitFor(),
      familyRestored.locator('#loginForm').waitFor(),
      restored.locator('#loginForm').waitFor(),
    ]);
    await revocation;
    assert.ok(revocations.includes(refreshedToken));
    console.log('PASS: two apps share one renewal and logout revokes the latest token across related tabs');

    await signIn(school, 'owner@example.test', true);
    await school.locator('#workspace').waitFor();
    deniedWorkspaceToken = `access-${sequence}`;
    const rotating = gate();
    blockedRefresh = rotating;
    blockedLogout = gate();
    const rotation = school.waitForRequest(request => request.url().includes('grant_type=refresh_token'));
    await school.locator('[data-action="reload"]').click();
    await rotation;
    const renewedRevocation = school.waitForRequest(request =>
      request.url().includes('/auth/logout') && request.headers().authorization !== 'Bearer ' + deniedWorkspaceToken);
    await school.locator('#signOut').click();
    await school.locator('#signInForm').waitFor();
    rotating.release();
    await renewedRevocation;
    blockedLogout.release();
    assert.equal(await school.locator('#workspace').isVisible(), false);
    assert.equal(await school.evaluate(storageKey => sessionStorage.getItem(storageKey), key), null);
    assert.deepEqual(errors, []);
    console.log('PASS: sign-out revokes a token that was still rotating and leaves the sign-in form visible');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
