// Signs a Playwright page in without ever touching Cognito's Hosted UI.
//
// The app reads its session from sessionStorage key "smartretailx.auth" as
// {id_token, access_token} (frontend/src/auth/cognito.js) — everything else
// (email, admin/customer role) is derived by decoding the ID token itself.
// addInitScript() runs before the app's own scripts on every navigation, so
// the session is already present the moment AuthProvider mounts — no extra
// reload needed, and no dependency on the real OAuth redirect flow, which
// isn't this app's own code to test anyway.
const base = require("@playwright/test");
const fs = require("fs");
const path = require("path");

function loadSession(role) {
  const file = path.join(__dirname, ".auth", `${role}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No saved ${role} session at ${file} — did global setup (auth/get-tokens.js) run?`);
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

async function signInAs(page, role) {
  const session = loadSession(role);
  await page.addInitScript((storedSession) => {
    window.sessionStorage.setItem("smartretailx.auth", JSON.stringify(storedSession));
  }, session);
}

const test = base.test.extend({
  customerPage: async ({ page }, use) => {
    await signInAs(page, "customer");
    await use(page);
  },
  adminPage: async ({ page }, use) => {
    await signInAs(page, "admin");
    await use(page);
  },
  // A second, independent admin browser context signed in as the SAME admin
  // account — simulates a second open tab for the WebSocket cross-tab proof,
  // without needing a second dedicated admin test account.
  secondAdminPage: async ({ browser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInAs(page, "admin");
    await use(page);
    await context.close();
  },
});

module.exports = { test, expect: base.expect };
