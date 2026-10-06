// Netflix browser automation (Playwright):
//   cleanupDevices()  - keep only the NEWEST device in "Manage access and devices", sign out the rest
//   rotatePassword()  - (optional, separate feature) change password + sign out everywhere
// Setup:  npm i playwright   then   npx playwright install --with-deps chromium
//
// NOTE: written from Netflix's page layout as I know it, NOT tested against the live site.
// Use DEVICE_CLEANUP=dry first: the bot then only REPORTS what it would sign out.
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

/* ---------------- pure logic (unit-tested) ---------------- */

const STOP = new Set(["the", "and", "for", "app", "web", "browser", "device", "netflix", "with", "your"]);
const WEAK = new Set(["tv", "smart", "phone", "mobile", "tablet", "television"]);
const tokens = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
// does a row of Netflix's device list describe the device called `name` (from the email)?
function nameMatches(rowText, name) {
  const a = new Set(tokens(rowText));
  const shared = tokens(name).filter((w) => a.has(w));
  return shared.some((w) => !WEAK.has(w)) || shared.length >= 2;
}

// "5 minutes ago" / "2 hours ago" / "yesterday" / "Oct 3, 2026" -> minutes ago (Infinity if unreadable)
function parseAgeMinutes(text, now = Date.now()) {
  // Netflix's own device-list format: "05/10/26, 10:32 am IST" (day/month/year)
  const dm = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s*(\d{1,2}):(\d{2})\s*([ap]m)\b/i);
  if (dm) {
    let [, day, month, year, hour, min, ap] = dm;
    year = year.length === 2 ? 2000 + Number(year) : Number(year);
    hour = Number(hour) % 12 + (/pm/i.test(ap) ? 12 : 0);
    const ts = new Date(year, Number(month) - 1, Number(day), hour, Number(min)).getTime();
    if (!Number.isNaN(ts)) return Math.max(0, (now - ts) / 60000);
  }
  const t = text.toLowerCase();
  if (/just now|moments? ago|seconds? ago/.test(t)) return 0;
  let m;
  if ((m = t.match(/(\d+)\s*(?:minutes?|mins?)\s*ago/))) return Number(m[1]);
  if ((m = t.match(/(\d+)\s*hours?\s*ago/))) return Number(m[1]) * 60;
  if ((m = t.match(/(\d+)\s*days?\s*ago/))) return Number(m[1]) * 1440;
  if (/yesterday/.test(t)) return 1440;
  const d =
    text.match(/[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}/) || // Oct 3, 2026
    text.match(/\d{1,2} [A-Z][a-z]{2,8}\.? \d{4}/) || //   3 Oct 2026
    text.match(/\d{1,2}\/\d{1,2}\/\d{4}/); //               10/3/2026
  if (d) {
    const ts = Date.parse(d[0]);
    if (!Number.isNaN(ts)) return Math.max(0, (now - ts) / 60000);
  }
  return Infinity;
}

// rows: [{ idx, text, age }]. Keeps the newest device, removes the rest. Fails safe when unsure.
// ctx (optional): { keepName, oldNames } = device names saved from the sign-in emails
function planCleanup(rows, botHint, ctx) {
  const botRe = new RegExp(botHint || "linux", "i");
  const isBot = (r) => r.isCurrent || botRe.test(r.text);
  const lines = rows.map(
    (r) =>
      `- ${r.text.slice(0, 90)} => ` +
      (isBot(r) ? "(current/bot device, ignored)" : Number.isFinite(r.age) ? `${Math.round(r.age)} min ago` : "time unreadable")
  );
  const devices = rows.filter((r) => !isBot(r));
  if (devices.length < 2) return { action: "none", note: "Only one device found, nothing to sign out.", lines, remove: [] };
  // SHARED account (several customers): only ever remove devices that match THIS customer's
  // previous device names, and never one whose name also matches another customer's device.
  // No time-based fallback here, because the newest device may belong to someone else.
  if (ctx && ctx.shared) {
    if (!ctx.keepName || !ctx.oldNames || !ctx.oldNames.length) {
      return { action: "none", note: "Shared account: no earlier device saved for this customer, nothing to sign out.", lines, remove: [] };
    }
    const mine = devices.filter((d) => ctx.oldNames.some((n) => nameMatches(d.text, n)) && !nameMatches(d.text, ctx.keepName));
    const safe = mine.filter((d) => !(ctx.otherNames || []).some((n) => nameMatches(d.text, n)));
    if (!safe.length) {
      return mine.length
        ? { action: "abort", note: "Shared account: the old device's name also matches another customer's device, so nothing was signed out.", lines, remove: [] }
        : { action: "none", note: "Shared account: this customer's old device was not found in the list.", lines, remove: [] };
    }
    const keep = devices.find((d) => nameMatches(d.text, ctx.keepName)) || null;
    return { action: "remove", method: "name", keep, remove: safe, lines, note: "Shared account: matched this customer's old device by name." };
  }
  // 1) preferred: match rows to the device names saved from earlier sign-in emails
  if (ctx && ctx.keepName && ctx.oldNames && ctx.oldNames.length) {
    const matched = devices.filter(
      (d) => ctx.oldNames.some((n) => nameMatches(d.text, n)) && !nameMatches(d.text, ctx.keepName)
    );
    if (matched.length) {
      const keep = devices.find((d) => nameMatches(d.text, ctx.keepName)) || null;
      return { action: "remove", method: "name", keep, remove: matched, lines, note: "Matched by device name from the sign-in emails." };
    }
  }
  // 2) fallback: newest device by last-used time
  if (devices.some((d) => !Number.isFinite(d.age))) {
    return { action: "abort", note: "Couldn't read the last-used time of every device. Nothing changed.", lines, remove: [] };
  }
  const sorted = [...devices].sort((a, b) => a.age - b.age);
  if (sorted[1].age - sorted[0].age < 1) {
    return { action: "abort", note: "The two newest devices are too close in time to tell which is newer. Nothing changed.", lines, remove: [] };
  }
  return { action: "remove", method: "time", keep: sorted[0], remove: sorted.slice(1), lines, note: "Matched by last-used time." };
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

/* ---------------- device cleanup ---------------- */

// Finds every device card: a block of text containing Netflix's own date format
// ("05/10/26, 10:32 am IST") plus a clickable chevron/expand control. The "CURRENT DEVICE"
// badge (the bot's own browser session) is flagged so it is never touched.
async function readDevices(page) {
  const rows = await page.evaluate(() => {
    document.querySelectorAll("[data-dev-idx]").forEach((e) => {
      e.removeAttribute("data-dev-idx");
      e.removeAttribute("data-dev-toggle");
    });
    const dateRe = /\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*[ap]m/i;
    const dateEls = [...document.querySelectorAll("*")].filter(
      (e) => e.children.length === 0 && dateRe.test(e.textContent || "")
    );
    const cards = [];
    const seen = new Set();
    for (const de of dateEls) {
      let card = de;
      let toggle = null;
      for (let k = 0; k < 8 && card.parentElement; k++) {
        card = card.parentElement;
        toggle = card.querySelector('button, [role="button"]');
        if (toggle && (card.innerText || "").length < 400) break;
      }
      if (seen.has(card)) continue;
      seen.add(card);
      cards.push({ card, toggle });
    }
    return cards.map(({ card, toggle }, i) => {
      card.setAttribute("data-dev-idx", String(i));
      (toggle || card).setAttribute("data-dev-toggle", String(i));
      return {
        idx: i,
        text: (card.innerText || "").replace(/\s+/g, " ").trim(),
        isCurrent: /current device/i.test(card.innerText || ""),
      };
    });
  });
  return rows.map((r) => ({ ...r, age: parseAgeMinutes(r.text) }));
}

// opts: { dryRun, botHint }

// opts: { dryRun, botHint }  -> { report, removed, warn }
async function cleanupDevices(accId, acc, getCode, opts = {}) {
  const { browser, context, page, file } = await openBrowser(accId);
  try {
    await ensureSignedIn(page, context, acc, getCode, file);
    // Prefer the left-nav "Devices" link (netflix.com/account/devices-like page); fall back to the
    // "Manage access and devices" quick link on the main account page if the nav isn't there.
    const devicesNav = page.getByRole("link", { name: /^devices$/i }).first();
    const manageLink = page.getByRole("link", { name: /manage access and devices/i }).first();
    if (await devicesNav.count()) await devicesNav.click();
    else await manageLink.click();
    await page.waitForLoadState("domcontentloaded");
    if (await passMfaIfAsked(page, context, getCode)) {
      // after confirming, Netflix may drop us back on the account page
      if (await devicesNav.isVisible().catch(() => false)) await devicesNav.click();
      else if (await manageLink.isVisible().catch(() => false)) await manageLink.click();
    }
    await page.waitForTimeout(3000);

    const planFn = (rows) => (opts.planner ? opts.planner(rows) : planCleanup(rows, opts.botHint, opts.ctx));
    const first = planFn(await readDevices(page));
    let report = first.lines.join("\n") + (first.note ? `\n${first.note}` : "");
    if (first.action !== "remove") {
      return { report, removed: 0, warn: first.action === "abort" };
    }
    report += `\n${first.keep ? "Keeping: " + first.keep.text.slice(0, 60) : "Keeping: (the device not listed below)"}\nWould sign out: ${first.remove.map((r) => r.text.slice(0, 40)).join(" | ")}`;
    if (opts.dryRun) return { report: report + "\n(dry run - nothing was signed out)", removed: 0, warn: false };

    let removed = 0;
    for (let i = 0; i < 8; i++) {
      const plan = planFn(await readDevices(page));
      if (plan.action !== "remove" || plan.method !== first.method) break; // never switch method mid-way
      const target = plan.remove[plan.remove.length - 1];
      const card = page.locator(`[data-dev-idx="${target.idx}"]`);
      // the card may already be expanded with "Sign Out" visible - only click the chevron
      // if it isn't, since clicking an already-open card would collapse it instead
      let signOut = card.getByRole("button", { name: /^sign out$/i }).first();
      if (!(await signOut.isVisible().catch(() => false))) {
        await page.locator(`[data-dev-toggle="${target.idx}"]`).click();
        await page.waitForTimeout(1000);
        signOut = card.getByRole("button", { name: /^sign out$/i }).first();
      }
      if (!(await signOut.count())) signOut = page.getByRole("button", { name: /sign out/i }).first();
      if (!(await signOut.count())) throw new Error(`No "Sign Out" button found for device: ${target.text.slice(0, 60)}`);
      await signOut.click();
      const dlg = page.getByRole("dialog");
      if (await dlg.count()) await dlg.getByRole("button", { name: /sign out|confirm|yes/i }).first().click();
      await page.waitForTimeout(1500);
      removed++;
      await page.waitForTimeout(3000);
    }
    return { report: report + `\nSigned out ${removed} device(s).`, removed, warn: false };
  } catch (err) {
    err.shot = await page.screenshot().catch(() => null);
    throw err;
  } finally {
    await browser.close();
  }
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

module.exports = { cleanupDevices, rotatePassword, _test: { parseAgeMinutes, planCleanup, nameMatches } };
