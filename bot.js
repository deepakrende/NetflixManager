// npm i node-telegram-bot-api googleapis dotenv      (Node 18+)
require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const { parseDeviceInfo } = require("./emailinfo");

// ---- .env ----
// TELEGRAM_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_ID
// GOOGLE_REFRESH_TOKEN         (optional: ONE shared inbox that receives all Netflix emails)
// DATA_FILE=/data/customers.json, ACCOUNTS_FILE=/data/accounts.json   (Railway Volume paths)
// AUTO_RESET=1                     (optional: password change + sign-out-everywhere when a login is released)
// DEVICE_CLEANUP=off|dry|on        (keep only the user's NEWEST device on Netflix; start with "dry")
// DEVICE_CLEANUP_DELAY_MIN=5       (minutes after /otp before the check runs)
// WATCH_INTERVAL_SEC=60          (how often Gmail is checked for "new device" emails)
// WATCH_CLEANUP_DELAY_MIN=1       (minutes after a new device signs in before the old one is removed)
// BOT_DEVICE_HINT=linux            (regex that matches the bot's own browser in Netflix's device list)
// SESSIONS_DIR=/data/sessions      (saved Netflix sessions, keep on the Volume)

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const isAdmin = (msg) => String(msg.from.id) === process.env.ADMIN_ID;
const notifyAdmin = (t) => bot.sendMessage(process.env.ADMIN_ID, t).catch(() => {});

/* ===================== customers + subscriptions ===================== */
// telegramId -> expiry timestamp (ms), or null = LIFETIME
const DATA_FILE = process.env.DATA_FILE || "./customers.json";
const customers = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  for (const [id, exp] of Object.entries(saved)) customers.set(Number(id), exp);
} catch (e) {}
const saveCustomers = () => fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(customers)));
function hasAccess(id) {
  if (!customers.has(id)) return false;
  const exp = customers.get(id);
  return exp === null || exp > Date.now();
}
function describeExpiry(exp) {
  if (exp === null) return "Lifetime";
  return new Date(exp).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/* ===================== login pool + assignments ===================== */
// accounts.json:
// { "accounts": { "nf1": { "email": "...", "password": "...", "refreshToken": "(optional)",
//                          "capacity": 1, "status": "ready" } },
//   "assignments": { "<telegramId>": "nf1" }, "lastChange": {} }
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || "./accounts.json";
let store = { accounts: {}, assignments: {}, lastChange: {} };
try {
  store = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
} catch (e) {}
store.accounts = store.accounts || {};
store.assignments = store.assignments || {};
store.lastChange = store.lastChange || {};
store.watch = store.watch || {}; // accountId -> ms timestamp of the last 'new device' email handled
store.devices = store.devices || {}; // telegramId -> [{accId,emailId,at,device,profile,location,raw}]
const saveStore = () => fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2));

const usersOn = (accId) => Object.values(store.assignments).filter((a) => a === accId).length;

// first "ready" account with free capacity, skipping the one the user already has
function pickAccount(excludeId) {
  return Object.entries(store.accounts).find(
    ([id, a]) => id !== excludeId && (a.status || "ready") === "ready" && usersOn(id) < (a.capacity || 1)
  );
}

// Remove a user's assignment and quarantine the account until you reset it.
function releaseUser(userId) {
  const accId = store.assignments[userId];
  if (!accId) return null;
  delete store.assignments[userId];
  delete store.devices[userId];
  if (store.accounts[accId]) store.accounts[accId].status = "needs_reset";
  saveStore();
  return accId;
}
function adminResetNotice(accId, userId, why) {
  const acc = store.accounts[accId];
  const others = usersOn(accId);
  notifyAdmin(
    `Account ${accId} (${acc ? acc.email : "?"}) was released by user ${userId} (${why}).\n` +
      `Sign out of all devices and change the password in Netflix, then run:\n` +
      `/setpass ${accId} <newpassword>\n/ready ${accId}` +
      (others ? `\nNote: ${others} other user(s) are still assigned to it.` : "")
  );
}

// ---- automatic Netflix reset (opt-in: AUTO_RESET=1, needs netflix.js + playwright) ----
let resetQueue = Promise.resolve(); // one browser at a time
function afterRelease(accId, userId, why) {
  if (process.env.AUTO_RESET === "1" && usersOn(accId) === 0) {
    notifyAdmin(`Account ${accId} released (${why}). Signing out all devices + changing the password automatically...`);
    resetQueue = resetQueue.then(() => autoReset(accId)).catch(console.error);
  } else {
    adminResetNotice(accId, userId, why);
  }
}
async function autoReset(accId) {
  const acc = store.accounts[accId];
  if (!acc) return;
  try {
    const { rotatePassword } = require("./netflix");
    const res = await rotatePassword(
      acc,
      (since) => getLatestNetflixCode(acc, since),
      (pass) => {
        acc.pendingPassword = pass; // saved BEFORE Netflix is changed, never lost
        saveStore();
      },
      accId
    );
    acc.password = res.password;
    delete acc.pendingPassword;
    acc.status = "ready";
    saveStore();
    notifyAdmin(`${accId}: all devices signed out, new password set, account is back in the pool.`);
  } catch (e) {
    console.error(e);
    notifyAdmin(
      `Automatic reset FAILED for ${accId}: ${e.message}\n` +
        (acc.pendingPassword
          ? `The new password may or may not have been applied. Try the old password first, then this one: ${acc.pendingPassword}\n`
          : "Password was not changed.\n") +
        `Fix it manually, then /setpass ${accId} <password> and /ready ${accId}.`
    );
    if (e.shot) bot.sendPhoto(process.env.ADMIN_ID, e.shot).catch(() => {});
  }
}

// remember which device asked for the code (name/profile/location come from the email)
function recordDevice(userId, accId, info, emailId) {
  if (!info || !emailId) return false;
  // the bot's own headless browser also triggers "new device" emails - never record it
  if (info.device && new RegExp(process.env.BOT_DEVICE_HINT || "linux", "i").test(info.device)) return false;
  const list = (store.devices[userId] = store.devices[userId] || []);
  if (list.some((r) => r.emailId === emailId)) return false; // already saved
  list.push({ accId, emailId, at: Date.now(), device: info.device, profile: info.profile, location: info.location, when: info.when, raw: info.raw });
  if (list.length > 10) list.shift();
  saveStore();
  return true;
}

// ---- one-device-per-user cleanup (DEVICE_CLEANUP=dry|on) ----
const cleanupTimers = new Map();
const lastDone = new Map();
function queueCleanup(accId, userId, manual) {
  resetQueue = resetQueue.then(() => runCleanup(accId, userId, manual)).catch(console.error);
}
// called after a code/link was delivered: check the device list a few minutes later
function scheduleCleanup(accId, userId, delayMin) {
  if ((process.env.DEVICE_CLEANUP || "off") === "off") return;
  const tkey = `${accId}:${userId}`;
  clearTimeout(cleanupTimers.get(tkey));
  const ms = Number(delayMin !== undefined ? delayMin : process.env.DEVICE_CLEANUP_DELAY_MIN || 5) * 60000;
  cleanupTimers.set(
    tkey,
    setTimeout(() => {
      cleanupTimers.delete(tkey);
      queueCleanup(accId, userId, false);
    }, ms)
  );
}
async function runCleanup(accId, userId, manual) {
  const mode = process.env.DEVICE_CLEANUP || "off";
  const acc = store.accounts[accId];
  if (mode === "off" || !acc || store.assignments[userId] !== accId) return;
  const say = (t) => manual && bot.sendMessage(userId, t).catch(() => {});
  const shared = usersOn(accId) > 1;
  try {
    const { cleanupDevices } = require("./netflix");
    const all = (store.devices[userId] || []).filter((r) => r.accId === accId);
    const latest = all[all.length - 1];
    if (shared && !(latest && latest.device)) return say("I couldn't tell which device you just signed in, so nothing was changed.");
    // on a shared account, collect the other customers' device names so we never touch those
    const otherNames = shared
      ? Object.entries(store.assignments)
          .filter(([u, a]) => a === accId && String(u) !== String(userId))
          .flatMap(([u]) => (store.devices[u] || []).map((r) => r.device))
          .filter(Boolean)
      : [];
    const ctx = latest && latest.device ? { keepName: latest.device, oldNames: all.slice(0, -1).map((r) => r.device).filter(Boolean), shared, otherNames } : null;
    const r = await cleanupDevices(accId, acc, (since) => getLatestNetflixCode(acc, since), {
      dryRun: mode !== "on",
      botHint: process.env.BOT_DEVICE_HINT || "linux",
      ctx,
    });
    if (mode === "on" && r.removed > 0 && latest) {
      store.devices[userId] = [latest]; // only the current device stays on record
      saveStore();
    }
    if (mode !== "on" || r.removed > 0 || r.warn) notifyAdmin(`Device check ${accId} (${mode}):\n${r.report}`);
    if (mode !== "on") return say("Check complete.");
    if (r.removed > 0) {
      bot.sendMessage(userId, "Your previous device was signed out. Your new device is active.").catch(() => {});
    } else if (r.warn) {
      say("I couldn't tell which device is older, so I changed nothing. The seller has been notified.");
    } else {
      say("No other device found to sign out.");
    }
  } catch (e) {
    console.error(e);
    notifyAdmin(`Device cleanup failed for ${accId}: ${e.message}`);
    if (e.shot) bot.sendPhoto(process.env.ADMIN_ID, e.shot).catch(() => {});
    say("Something went wrong while checking devices. The seller has been notified.");
  }
}

/* ===================== Gmail (one client per inbox) ===================== */
const gmailClients = {};
function gmailFor(acc) {
  const token = acc.refreshToken || process.env.GOOGLE_REFRESH_TOKEN;
  if (!gmailClients[token]) {
    const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    o.setCredentials({ refresh_token: token });
    gmailClients[token] = google.gmail({ version: "v1", auth: o });
  }
  return gmailClients[token];
}

function walkParts(payload, mime) {
  let out = "";
  const walk = (p) => {
    if (p.body && p.body.data && (!mime || p.mimeType === mime)) {
      out += Buffer.from(p.body.data, "base64").toString("utf8") + "\n";
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return out;
}
function extractGetCodeLink(html) {
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/get\s*code/i.test(m[2].replace(/<[^>]+>/g, ""))) return m[1].replace(/&amp;/g, "&");
  }
  return null;
}
function findCode(text) {
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const near = clean.match(/code[^0-9]{0,120}\b(\d{4,6})\b/i);
  return near ? near[1] : null;
}

// Returns { code } or { link } or null, for ONE specific Netflix account
async function getLatestNetflixCode(acc, afterSec) {
  const gmail = gmailFor(acc);
  // with a shared inbox, only look at emails sent to this account's address
  const toFilter = acc.refreshToken ? "" : ` to:${acc.email}`;
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `from:netflix.com newer_than:10m${toFilter}${afterSec ? ` after:${afterSec}` : ""}`,
    maxResults: 5,
  });
  for (const m of list.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const subject = (full.data.payload.headers.find((h) => h.name === "Subject") || {}).value || "";
    const html = walkParts(full.data.payload, "text/html");
    const plain = walkParts(full.data.payload, "text/plain");
    const info = parseDeviceInfo(subject + " " + plain + " " + html);
    const direct = findCode(subject + " " + plain + " " + html);
    if (direct) return { code: direct, info, emailId: m.id };
    const link = extractGetCodeLink(html);
    if (link) return { link, info, emailId: m.id };
  }
  return null;
}

/* ===================== watcher: "A new device is using your account" ===================== */
// Netflix sends this email when a device signs in. That is the moment to save the device
// and (a minute later) remove the user's older device. Works without the user pressing /otp.
let watching = false;
async function checkNewDeviceEmails(accId) {
  const acc = store.accounts[accId];
  const users = Object.entries(store.assignments).filter(([, a]) => a === accId).map(([u]) => u);
  if (!acc || users.length !== 1) return; // single-user accounts only
  const userId = users[0];
  if (!store.watch[accId]) {
    store.watch[accId] = Date.now();
    return saveStore();
  }
  const last = store.watch[accId];
  const toFilter = acc.refreshToken ? "" : ` to:${acc.email}`;
  const gmail = gmailFor(acc);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: `from:netflix.com (subject:"new device" OR subject:"using your account") newer_than:1d${toFilter}`,
    maxResults: 10,
  });
  let newest = last;
  let recorded = false;
  for (const m of list.data.messages || []) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
    const at = Number(full.data.internalDate || 0);
    if (at <= last) continue;
    newest = Math.max(newest, at);
    const subject = (full.data.payload.headers.find((h) => h.name === "Subject") || {}).value || "";
    const info = parseDeviceInfo(subject + " " + walkParts(full.data.payload, "text/plain") + " " + walkParts(full.data.payload, "text/html"));
    if (recordDevice(userId, accId, info, m.id)) recorded = true;
  }
  if (newest !== last) {
    store.watch[accId] = newest;
    saveStore();
  }
  if (recorded) scheduleCleanup(accId, userId, Number(process.env.WATCH_CLEANUP_DELAY_MIN || 1));
}
if ((process.env.DEVICE_CLEANUP || "off") !== "off") {
  setInterval(async () => {
    if (watching) return;
    watching = true;
    try {
      for (const accId of Object.keys(store.accounts)) await checkNewDeviceEmails(accId).catch((e) => console.error("watch:", e.message));
    } finally {
      watching = false;
    }
  }, Number(process.env.WATCH_INTERVAL_SEC || 60) * 1000);
}

/* ===================== customer commands ===================== */
const lastOtp = new Map();
const OTP_COOLDOWN_MS = 30 * 1000;
const NO_PLAN = "Your subscription is not active. Contact the seller to renew.";

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "/login - get your Netflix login\n/otp - get the sign-in code (request it on Netflix first)\n/mylogin - show your current login\n/done - after logging in on a new device, sign out the old one\n/status - subscription validity"
  );
});

// /login: gives a NEW login. The user's previous login (if any) is deactivated.
bot.onText(/^\/login/, (msg) => {
  const id = msg.from.id;
  const chat = msg.chat.id;
  if (!hasAccess(id)) return bot.sendMessage(chat, NO_PLAN);

  const oldId = store.assignments[id];
  // no cooldown: customers may change their login at any time

  const picked = pickAccount(oldId);
  if (!picked) {
    const cur = oldId && store.accounts[oldId];
    if (cur) {
      // nothing else to switch to: just show the login they already have
      return bot.sendMessage(
        chat,
        `No other login is available right now, so you keep your current one:\nEmail: ${cur.email}\n\n` +
          `On Netflix choose "Use a sign-in code" (no password needed), then send /otp here.`
      );
    }
    return bot.sendMessage(chat, "No login is available right now. Please contact the seller.");
  }

  // new login is secured first, then the old one is released
  const [newId, acc] = picked;
  if (oldId) releaseUser(id);
  store.assignments[id] = newId;
  store.lastChange[id] = Date.now();
  store.watch[newId] = Date.now(); // only emails from now on count for this user
  saveStore();

  bot.sendMessage(
    chat,
    `Your Netflix login:\nEmail: ${acc.email}\n\n` +
      `On Netflix enter this email and choose "Use a sign-in code" (no password needed). Request the code there, then send /otp here.` +
      (oldId ? "\n\nYour previous login has been deactivated." : "")
  );
  if (oldId) afterRelease(oldId, id, "user got a new login");
});

bot.onText(/^\/mylogin/, (msg) => {
  const id = msg.from.id;
  if (!hasAccess(id)) return bot.sendMessage(msg.chat.id, NO_PLAN);
  const acc = store.accounts[store.assignments[id]];
  if (!acc) return bot.sendMessage(msg.chat.id, "You don't have a login yet. Send /login.");
  bot.sendMessage(msg.chat.id, `Email: ${acc.email}`);
});

bot.onText(/^\/otp/, async (msg) => {
  const id = msg.from.id;
  if (!hasAccess(id)) return bot.sendMessage(msg.chat.id, NO_PLAN);
  const acc = store.accounts[store.assignments[id]];
  if (!acc) return bot.sendMessage(msg.chat.id, "You don't have a login yet. Send /login first.");

  if (Date.now() - (lastOtp.get(id) || 0) < OTP_COOLDOWN_MS) {
    return bot.sendMessage(msg.chat.id, "Please wait 30 seconds before trying again.");
  }
  lastOtp.set(id, Date.now());

  try {
    const result = await getLatestNetflixCode(acc);
    let text;
    if (result && result.code) text = `Your code: ${result.code}\n(Valid for a few minutes)`;
    else if (result && result.link) text = `Tap this link now to see your code (it expires soon):\n${result.link}`;
    else text = "No new code found. Request the code on Netflix first, then try again in a few seconds.";
    bot.sendMessage(msg.chat.id, text);
    if (result && (result.code || result.link)) {
      recordDevice(id, store.assignments[id], result.info, result.emailId);
      scheduleCleanup(store.assignments[id], id);
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, "Something went wrong. Try again shortly.");
  }
});

// /done: "my new device is logged in" -> remove the older device right now
bot.onText(/^\/done/, (msg) => {
  const id = msg.from.id;
  if (!hasAccess(id)) return bot.sendMessage(msg.chat.id, NO_PLAN);
  const accId = store.assignments[id];
  if (!accId) return bot.sendMessage(msg.chat.id, "You don't have a login yet. Send /login first.");
  if ((process.env.DEVICE_CLEANUP || "off") === "off") return bot.sendMessage(msg.chat.id, "Not available right now.");
  if (Date.now() - (lastDone.get(id) || 0) < 2 * 60 * 1000) {
    return bot.sendMessage(msg.chat.id, "Please wait 2 minutes before trying again.");
  }
  lastDone.set(id, Date.now());
  bot.sendMessage(msg.chat.id, "Checking your devices, this takes a minute...");
  clearTimeout(cleanupTimers.get(`${accId}:${id}`));
  queueCleanup(accId, id, true);
});

bot.onText(/^\/status/, (msg) => {
  const id = msg.from.id;
  if (!customers.has(id)) return bot.sendMessage(msg.chat.id, "No subscription found.");
  const exp = customers.get(id);
  bot.sendMessage(
    msg.chat.id,
    hasAccess(id) ? `Active. Valid until: ${describeExpiry(exp)}` : `Expired on ${describeExpiry(exp)}. Contact the seller to renew.`
  );
});

/* ===================== admin commands ===================== */
// /add <telegramId> <days|lifetime>   (days are added on top if still active)
bot.onText(/^\/add (\d+) (\d+|lifetime)/i, (msg, m) => {
  if (!isAdmin(msg)) return;
  const id = Number(m[1]);
  const plan = m[2].toLowerCase();
  if (plan === "lifetime") {
    customers.set(id, null);
  } else {
    const current = customers.get(id);
    if (current === null) return bot.sendMessage(msg.chat.id, `${id} already has lifetime access.`);
    const base = current && current > Date.now() ? current : Date.now();
    customers.set(id, base + Number(plan) * 86400000);
  }
  saveCustomers();
  bot.sendMessage(msg.chat.id, `${id}: access until ${describeExpiry(customers.get(id))}`);
});

// /remove <telegramId>  -> removes subscription AND releases their login
bot.onText(/^\/remove (\d+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const accId = releaseUser(m[1]);
  customers.delete(Number(m[1]));
  saveCustomers();
  bot.sendMessage(msg.chat.id, `Removed ${m[1]}.`);
  if (accId) afterRelease(accId, m[1], "customer removed");
});

// /unassign <telegramId>  -> take a customer off their login but KEEP their subscription
// (the account stays "ready"; use this to clean up an account that has too many users)
bot.onText(/^\/unassign(?:@\w+)?\s+(\d+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const accId = store.assignments[m[1]];
  if (!accId) return bot.sendMessage(msg.chat.id, "That user has no login assigned.");
  delete store.assignments[m[1]];
  delete store.devices[m[1]];
  saveStore();
  bot.sendMessage(msg.chat.id, `${m[1]} was taken off ${accId}. ${accId} now has ${usersOn(accId)} user(s). Their subscription is unchanged.`);
});

bot.onText(/^\/list/, (msg) => {
  if (!isAdmin(msg)) return;
  if (!customers.size) return bot.sendMessage(msg.chat.id, "No customers yet.");
  const lines = [...customers.entries()].map(([id, exp]) => {
    const acc = store.assignments[id];
    return `${id}: ${describeExpiry(exp)}${exp !== null && exp < Date.now() ? " (expired)" : ""} | login: ${acc || "none"}`;
  });
  bot.sendMessage(msg.chat.id, lines.join("\n"));
});

// /devices <telegramId> -> what the bot saved from that user's sign-in emails
bot.onText(/^\/devices (\d+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const list = store.devices[m[1]] || [];
  if (!list.length) return bot.sendMessage(msg.chat.id, "Nothing saved for that user yet.");
  bot.sendMessage(
    msg.chat.id,
    list
      .map((r, i) => `${i + 1}. ${r.device || "(device not found)"} | name: ${r.profile || "-"} | ${r.location || "-"} | ${r.when || new Date(r.at).toLocaleString("en-IN")}\n   email text: ${r.raw}`)
      .join("\n")
  );
});

// /accounts -> pool overview
bot.onText(/^\/accounts/, (msg) => {
  if (!isAdmin(msg)) return;
  const rows = Object.entries(store.accounts).map(
    ([id, a]) => `${id}: ${a.email} | ${a.status || "ready"} | users ${usersOn(id)}/${a.capacity || 1}`
  );
  bot.sendMessage(msg.chat.id, rows.length ? rows.join("\n") : "No accounts in the pool. Add one with /addaccount <id> <email> <password> [capacity]");
});

// /addaccount <id> <email> <password> [capacity]  -> add a Netflix login to the pool
// (the bot deletes your message afterwards so the password doesn't sit in the chat)
bot.onText(/^\/addaccount(?:@\w+)?\s+(\S+)\s+(\S+@\S+)\s+(\S+)(?:\s+(\d+))?\s*$/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const [, id, email, password, cap] = m;
  const capacity = cap ? Math.max(1, Number(cap)) : 1;
  const done = (t) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    bot.sendMessage(msg.chat.id, t);
  };
  if (store.accounts[id]) return done(`Account id "${id}" already exists. Use /setpass ${id} <password> to change its password, or /delaccount ${id} first.`);
  if (Object.values(store.accounts).some((a) => a.email.toLowerCase() === email.toLowerCase()))
    return done("That email is already in the pool.");
  store.accounts[id] = { email, password, capacity, status: "ready" };
  saveStore();
  done(`Added ${id} (${email}), capacity ${capacity}, status ready. Your message with the password was deleted.`);
});
bot.onText(/^\/addaccount(?:@\w+)?\s*$/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, "Usage: /addaccount <id> <email> <password> [capacity]\nExample: /addaccount nf2 name@gmail.com MyPass123 1");
});

// /setcap <id> <number>  -> change how many customers can share an account
bot.onText(/^\/setcap(?:@\w+)?\s+(\S+)\s+(\d+)\s*$/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const acc = store.accounts[m[1]];
  if (!acc) return bot.sendMessage(msg.chat.id, "Unknown account id.");
  const cap = Math.max(1, Number(m[2]));
  acc.capacity = cap;
  saveStore();
  bot.sendMessage(msg.chat.id, `${m[1]} capacity set to ${cap} (currently ${usersOn(m[1])} user(s) assigned).`);
});

// /delaccount <id>  -> remove an account from the pool (only if nobody is assigned to it)
bot.onText(/^\/delaccount(?:@\w+)?\s+(\S+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const id = m[1];
  if (!store.accounts[id]) return bot.sendMessage(msg.chat.id, "Unknown account id.");
  const n = usersOn(id);
  if (n > 0) return bot.sendMessage(msg.chat.id, `${id} still has ${n} user(s) assigned. Use /remove <telegramId> for them first.`);
  delete store.accounts[id];
  delete store.watch[id];
  saveStore();
  bot.sendMessage(msg.chat.id, `Removed ${id} from the pool.`);
});

// /ready <accountId>  -> put a reset account back in the pool
bot.onText(/^\/ready (\S+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const acc = store.accounts[m[1]];
  if (!acc) return bot.sendMessage(msg.chat.id, "Unknown account id.");
  acc.status = "ready";
  saveStore();
  bot.sendMessage(msg.chat.id, `${m[1]} is back in the pool.`);
});

// /setpass <accountId> <newpassword>  (delete your message afterwards)
bot.onText(/^\/setpass (\S+) (\S+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const acc = store.accounts[m[1]];
  if (!acc) return bot.sendMessage(msg.chat.id, "Unknown account id.");
  acc.password = m[2];
  delete acc.pendingPassword;
  saveStore();
  bot.sendMessage(msg.chat.id, `Password updated for ${m[1]}. Delete your message with the password.`);
});

/* ===================== background jobs ===================== */
// Hourly: release logins of customers whose subscription has ended
setInterval(() => {
  for (const [uid, accId] of Object.entries(store.assignments)) {
    if (!hasAccess(Number(uid))) {
      releaseUser(uid);
      bot.sendMessage(Number(uid), "Your subscription has ended and your login was deactivated. Contact the seller to renew.").catch(() => {});
      afterRelease(accId, uid, "subscription expired");
    }
  }
}, 60 * 60 * 1000);

// Daily: remind customers ~3 days before expiry
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of customers) {
    if (exp !== null && exp > now && exp - now < 3 * 86400000 && exp - now > 2 * 86400000) {
      bot.sendMessage(id, `Your subscription ends on ${describeExpiry(exp)}. Contact the seller to renew.`).catch(() => {});
    }
  }
}, 24 * 60 * 60 * 1000);

console.log("OTP bot running");
