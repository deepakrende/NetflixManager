// Netflix browser automation (Playwright):
//   rotatePassword()  - (optional, AUTO_RESET) change password + sign out everywhere
// Setup:  npm i playwright   then   npx playwright install --with-deps chromium
//
// NOTE: written from Netflix's page layout as I know it, NOT tested against the live site.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = process.env.SESSIONS_DIR || "./sessions";
const ACCOUNT_URL = "https://www.netflix.com/account";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makePassword = () => crypto.randomBytes(9).toString("base64url") + "aA1!";

function findCode(text) {
  const clean = text.replace(/\s+/g, " ");
  const m = clean.match(/code[^0-9]{0,120}\b(\d{4,6})\b/i) || clean.match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

/* ---------------- browser helpers ---------------- */

async function openBrowser(accId) {
  const { chromium } = require("playwright");
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = path.join(SESSIONS_DIR, `${accId}.json`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    ...(fs.existsSync(file) ? { storageState: file } : {}), // reuse the saved session = no new code each time
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  return { browser, context, page, file };
}

async function waitForVerification(getCode, sinceSec, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await getCode(sinceSec);
    if (r) return r;
    await sleep(5000);
  }
  return null;
}

// Netflix asks "First, let us make sure it is you" (/mfa) before showing devices or changing the password.
// Returns true if that step was shown and passed.
async function passMfaIfAsked(page, context, getCode) {
  await page.waitForTimeout(2000);
  const onMfa =
    /\/mfa/.test(page.url()) ||
    (await page.getByText(/make sure it('| i)?s you/i).first().isVisible().catch(() => false));
  if (!onMfa) return false;
  const sinceSec = Math.floor(Date.now() / 1000) - 5;
  await page.getByText(/email a code/i).first().click();
  await page.waitForTimeout(3000);
  const r = await waitForVerification(getCode, sinceSec);
  if (!r) throw new Error("the 'Email a code' message did not arrive in Gmail");
  let code = r.code;
  if (!code && r.link) {
    const p2 = await context.newPage();
    await p2.goto(r.link);
    await p2.waitForTimeout(3000);
    code = findCode(await p2.innerText("body"));
    await p2.close();
  }
  if (!code) throw new Error("could not read the code from the 'Email a code' message");
  if (!(await page.getByRole("textbox").first().isVisible().catch(() => false))) {
    const send = page.getByRole("button", { name: /send|continue|next/i }).first();
    if (await send.count()) await send.click();
  }
  await page.getByRole("textbox").first().fill(code);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4000);
  if (/\/mfa/.test(page.url())) throw new Error("Netflix did not accept the code on the confirmation step");
  return true;
}

const CODE_PROMPT = /verification code|sign-in code|enter (the |your )?code|we sent (you )?a code|email a code/i;

// Netflix shows a cookie banner that can cover the form: reject it so it never blocks a click
async function dismissCookies(page) {
  const btn = page.getByRole("button", { name: /^reject$/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function loginFlow(page, context, acc, getCode) {
  const startSec = Math.floor(Date.now() / 1000) - 5;
  await page.goto("https://www.netflix.com/login");
  await page.waitForTimeout(2500);
  await dismissCookies(page);
  await page.getByLabel(/email|mobile/i).first().fill(acc.email);

  // Netflix's login is often two steps: email -> "Continue" -> password (or a sign-in code)
  let pw = page.getByLabel(/password/i).first();
  if (!(await pw.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /^(continue|next)$/i }).first().click();
    await page.waitForTimeout(3500);
    await dismissCookies(page);
    pw = page.getByLabel(/password/i).first();
    const codeAlready = await page.getByText(CODE_PROMPT).first().isVisible().catch(() => false);
    if (!(await pw.isVisible().catch(() => false)) && !codeAlready) {
      const usePw = page.getByText(/use (your )?password|sign in with (a )?password/i).first();
      if (await usePw.count()) {
        await usePw.click().catch(() => {});
        await page.waitForTimeout(2000);
      }
      pw = page.getByLabel(/password/i).first();
    }
  }
  if (await pw.isVisible().catch(() => false)) {
    await pw.fill(acc.password);
    await page.getByRole("button", { name: /^(sign in|continue|next)$/i }).first().click();
    await page.waitForTimeout(5000);
  }

  const needsCode = await page
    .getByText(CODE_PROMPT)
    .first()
    .isVisible()
    .catch(() => false);
  if (needsCode) {
    const r = await waitForVerification(getCode, startSec);
    if (!r) throw new Error("verification email not found in Gmail");
    let code = r.code;
    if (!code && r.link) {
      const p2 = await context.newPage();
      await p2.goto(r.link);
      await p2.waitForTimeout(3000);
      code = findCode(await p2.innerText("body"));
      await p2.close();
    }
    if (!code) throw new Error("could not read the verification code");
    await page.getByRole("textbox").first().fill(code);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(5000);
  }
  if (/\/login/.test(page.url())) {
    throw new Error("sign-in failed (wrong password, captcha, or Netflix blocked the browser)");
  }
}

async function ensureSignedIn(page, context, acc, getCode, file) {
  const signedIn = () => /\/account/.test(page.url()) && !/\/login/.test(page.url());
  await page.goto(ACCOUNT_URL);
  await page.waitForTimeout(2000);
  if (!signedIn()) {
    await loginFlow(page, context, acc, getCode);
    await page.goto(ACCOUNT_URL);
    await page.waitForTimeout(2000);
    if (!signedIn()) throw new Error("could not open the account page after signing in");
  }
  await context.storageState({ path: file });
}

/* ---------------- password rotation (optional, AUTO_RESET) ---------------- */

async function rotatePassword(acc, getCode, beforeSave, accId = "reset") {
  const { browser, context, page, file } = await openBrowser(accId);
  const newPass = makePassword();
  try {
    await ensureSignedIn(page, context, acc, getCode, file);
    await page.goto("https://www.netflix.com/password");
    if (await passMfaIfAsked(page, context, getCode)) await page.goto("https://www.netflix.com/password");
    if (/\/login/.test(page.url())) throw new Error("not signed in when opening the password page");
    await page.getByLabel(/current password/i).fill(acc.password);
    await page.getByLabel(/^new password/i).fill(newPass);
    await page.getByLabel(/confirm new password/i).fill(newPass);
    const box = page.getByLabel(/require all devices/i);
    if (await box.count()) await box.check();
    else throw new Error('"Require all devices to sign in again" checkbox not found');
    await beforeSave(newPass); // stored first, never lost
    await page.getByRole("button", { name: /save/i }).click();
    await page.waitForTimeout(5000);
    if (/\/password/.test(page.url()) && (await page.getByText(/error|incorrect|try again/i).first().isVisible().catch(() => false))) {
      throw new Error("Netflix showed an error when saving the new password");
    }
    fs.rmSync(file, { force: true }); // old session is dead now
    return { password: newPass };
  } catch (err) {
    err.shot = await page.screenshot().catch(() => null);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { rotatePassword };
