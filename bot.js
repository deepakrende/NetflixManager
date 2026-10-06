// npm i node-telegram-bot-api googleapis dotenv      (Node 18+)
require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// ---- .env ----
// TELEGRAM_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_ID
// GOOGLE_REFRESH_TOKEN         (optional: ONE shared inbox that receives all Netflix emails)
// DATA_FILE=/data/customers.json, ACCOUNTS_FILE=/data/accounts.json   (Railway Volume paths)
// AUTO_RESET=1                     (optional: password change + sign-out-everywhere when a login is released)
// SESSIONS_DIR=/data/sessions      (saved Netflix sessions, keep on the Volume)

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const isAdmin = (msg) => String(msg.from.id) === process.env.ADMIN_ID;
const notifyAdmin = (t) => bot.sendMessage(process.env.ADMIN_ID, t).catch(() => {});

/* ===================== customers + subscriptions ===================== */
// telegramId -> expiry timestamp (ms), or null = LIFETIME
const DATA_FILE = process.env.DATA_FILE || "./customers.json";

// ---- safe JSON storage: atomic writes, hourly backup, never overwrite a file we couldn't read ----
const startupNotes = []; // sent to the admin once the bot is up
function loadJson(file, fallback) {
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  if (!fs.existsSync(file)) {
    if (fs.existsSync(file + ".bak")) {
      try {
        const d = read(file + ".bak");
        startupNotes.push(`${file} was missing; restored from its backup.`);
        return d;
      } catch (e) {}
    }
    return fallback;
  }
  try {
    return read(file);
  } catch (e) {
    console.error(`Could not read ${file}: ${e.message}`);
    try {
      const d = read(file + ".bak");
      startupNotes.push(`${file} was unreadable; restored from its backup.`);
      return d;
    } catch (e2) {}
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (e3) {}
    startupNotes.push(`${file} was unreadable and no backup worked. Started empty; the broken file was kept as ${file}.corrupt-*`);
    return fallback;
  }
}
const lastBackup = {};
function saveJson(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  if (fs.existsSync(file) && Date.now() - (lastBackup[file] || 0) > 3600000) {
    try {
      fs.copyFileSync(file, file + ".bak");
      lastBackup[file] = Date.now();
    } catch (e) {}
  }
  fs.renameSync(tmp, file); // the real file is replaced in one step, never half-written
}

const customers = new Map();
for (const [id, exp] of Object.entries(loadJson(DATA_FILE, {}))) customers.set(Number(id), exp);
const saveCustomers = () => saveJson(DATA_FILE, JSON.stringify(Object.fromEntries(customers)));
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
let store = loadJson(ACCOUNTS_FILE, { accounts: {}, assignments: {}, lastChange: {} });
store.accounts = store.accounts || {};
store.assignments = store.assignments || {};
store.lastChange = store.lastChange || {};
store.otp = store.otp || {}; // telegramId -> { used: n, until: ms }  (code approvals, see /otp)
const saveStore = () => saveJson(ACCOUNTS_FILE, JSON.stringify(store, null, 2));

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
  saveStore();
  return accId;
}
// ---- automatic Netflix reset (opt-in: AUTO_RESET=1, needs netflix.js + playwright) ----
let resetQueue = Promise.resolve(); // one browser at a time
function afterRelease(accId, userId, why) {
  if (process.env.AUTO_RESET === "1" && usersOn(accId) === 0) {
    notifyAdmin(`Account ${accId} released (${why}). Signing out all devices + changing the password automatically...`);
    resetQueue = resetQueue.then(() => autoReset(accId)).catch(console.error);
  }
  // otherwise nothing to do: the account stays "ready" and the slot is simply free again
}
async function autoReset(accId) {
  const acc = store.accounts[accId];
  if (!acc) return;
  if (!acc.password) return notifyAdmin(`Auto reset skipped for ${accId}: no password is stored for it. Set one with /setpass ${accId} <password>.`);
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

/* ===================== Gmail health + alerts ===================== */
const alertAt = {};
function alertAdmin(key, text, everyMin = 30) {
  if (Date.now() - (alertAt[key] || 0) < everyMin * 60000) return; // don't spam the admin
  alertAt[key] = Date.now();
  notifyAdmin(text);
}
// turn a Google error into something you can act on (null = not a Gmail access problem)
function gmailProblem(e) {
  const raw = String((e && e.message) || "") + " " + JSON.stringify((e && e.response && e.response.data) || {});
  if (/unauthorized_client|invalid_client/i.test(raw))
    return "Google rejects the client ID / secret / refresh token combination. Generate a new refresh token with the SAME client ID and secret that are set in Railway.";
  if (/invalid_grant/i.test(raw))
    return "The refresh token expired or was revoked (tokens last only 7 days while the OAuth consent screen is in 'Testing'). Generate a new refresh token.";
  if (/invalid credentials|login required|insufficient|\b40[13]\b|permission/i.test(raw))
    return "Google refused the Gmail request. Check that the Gmail API is enabled and the token has gmail.readonly access.";
  return null;
}
async function checkGmail() {
  const tokens = new Set([process.env.GOOGLE_REFRESH_TOKEN, ...Object.values(store.accounts).map((a) => a.refreshToken)].filter(Boolean));
  if (!tokens.size) return "No Gmail refresh token is set (GOOGLE_REFRESH_TOKEN).";
  for (const t of tokens) {
    try {
      await gmailFor({ refreshToken: t }).users.getProfile({ userId: "me" });
    } catch (e) {
      return gmailProblem(e) || `Gmail check failed: ${e.message}`;
    }
  }
  return null; // all good
}
async function gmailWatchdog() {
  const problem = await checkGmail();
  if (problem) alertAdmin("gmail-health", `Gmail access is BROKEN, customers can't get codes.\\n${problem}`, 360);
}
setTimeout(gmailWatchdog, 15000);
setInterval(gmailWatchdog, 6 * 3600000);

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
    const direct = findCode(subject + " " + plain + " " + html);
    if (direct) return { code: direct, at: Number(full.data.internalDate || 0) };
    const link = extractGetCodeLink(html);
    if (link) return { link, at: Number(full.data.internalDate || 0) };
  }
  return null;
}

/* ===================== customer commands ===================== */
const lastOtp = new Map();
const OTP_COOLDOWN_MS = 30 * 1000;
const NO_PLAN = "Your subscription is not active. Contact the seller to renew.";

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "/login - get your Netflix login\n/otp - get the sign-in code (request it on Netflix first)\n/mylogin - show your current login\n/status - subscription validity"
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

// ---- code approval: the first code is free, every further one needs the seller's OK ----
const OTP_FREE_USES = Number(process.env.OTP_FREE_USES || 1); // codes a customer gets without asking
const OTP_WINDOW_MS = Number(process.env.OTP_APPROVAL_WINDOW_MIN || 15) * 60000; // how long one OK stays valid
const pendingApproval = new Map(); // customerId -> time of the open request

function requestApproval(msg, id) {
  const chat = msg.chat.id;
  const t = pendingApproval.get(id);
  if (t && Date.now() - t < 30 * 60000) {
    return bot.sendMessage(chat, "Your request is already waiting for the seller's approval. You'll get a message here.");
  }
  pendingApproval.set(id, Date.now());
  const o = store.otp[id] || { used: 0 };
  const accId = store.assignments[id];
  const who = [msg.from.first_name, msg.from.username ? "@" + msg.from.username : ""].filter(Boolean).join(" ");
  bot
    .sendMessage(
      process.env.ADMIN_ID,
      `Code request\nCustomer: ${who} (${id})\nAccount: ${accId}\nCodes given so far: ${o.used}\n\nApprove a new device?`,
      { reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `otp_ok:${id}` }, { text: "Deny", callback_data: `otp_no:${id}` }]] } }
    )
    .catch(console.error);
  bot.sendMessage(chat, "Your request was sent to the seller for approval. You'll get a message here when it's decided.");
}

bot.on("callback_query", (q) => {
  if (String(q.from.id) !== process.env.ADMIN_ID) return bot.answerCallbackQuery(q.id).catch(() => {});
  const m = /^otp_(ok|no):(\d+)$/.exec(q.data || "");
  if (!m) return bot.answerCallbackQuery(q.id).catch(() => {});
  const uid = Number(m[2]);
  const edit = (t) => q.message && bot.editMessageText(t, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  pendingApproval.delete(uid);
  if (m[1] === "ok") {
    const o = (store.otp[uid] = store.otp[uid] || { used: 0, until: 0 });
    o.until = Date.now() + OTP_WINDOW_MS;
    saveStore();
    bot.sendMessage(uid, `Approved. Request the code on Netflix now, then send /otp here within ${Math.round(OTP_WINDOW_MS / 60000)} minutes.`).catch(() => {});
    edit(`Approved for ${uid}.`);
  } else {
    bot.sendMessage(uid, "Your request was not approved. Contact the seller.").catch(() => {});
    edit(`Denied for ${uid}.`);
  }
  bot.answerCallbackQuery(q.id).catch(() => {});
});

const accLock = new Map(); // accId -> { userId, at }: one customer at a time per account
const lastCode = new Map(); // accId -> { userId, emailAt }: the newest code already handed out
const OTP_LOCK_MS = Number(process.env.OTP_LOCK_SEC || 60) * 1000;

bot.onText(/^\/otp/, async (msg) => {
  const id = msg.from.id;
  if (!hasAccess(id)) return bot.sendMessage(msg.chat.id, NO_PLAN);
  const accId = store.assignments[id];
  const acc = store.accounts[accId];
  if (!acc) return bot.sendMessage(msg.chat.id, "You don't have a login yet. Send /login first.");

  const o = (store.otp[id] = store.otp[id] || { used: 0, until: 0 });
  const inWindow = o.until > Date.now();
  if (!inWindow && o.used >= OTP_FREE_USES) return requestApproval(msg, id);

  if (Date.now() - (lastOtp.get(id) || 0) < OTP_COOLDOWN_MS) {
    return bot.sendMessage(msg.chat.id, "Please wait 30 seconds before trying again.");
  }
  // another customer on the same account is fetching a code right now: wait, so codes can't get mixed up
  const lk = accLock.get(accId);
  if (lk && lk.userId !== id && Date.now() - lk.at < OTP_LOCK_MS) {
    return bot.sendMessage(msg.chat.id, "Another customer is getting a code on this account right now. Please try again in about a minute.");
  }
  lastOtp.set(id, Date.now());
  accLock.set(accId, { userId: id, at: Date.now() });
  const release = () => accLock.get(accId) && accLock.get(accId).userId === id && accLock.delete(accId);

  try {
    // never hand one customer the code that was already given to another customer
    const prev = lastCode.get(accId);
    const afterSec = prev && prev.userId !== id && prev.emailAt ? Math.floor(prev.emailAt / 1000) + 1 : undefined;
    const result = await getLatestNetflixCode(acc, afterSec);
    let text;
    if (result && result.code) text = `Your code: ${result.code}\n(Valid for a few minutes)`;
    else if (result && result.link) text = `Tap this link now to see your code (it expires soon):\n${result.link}`;
    else text = "No new code found. Request the code on Netflix first, then try again in a few seconds.";
    bot.sendMessage(msg.chat.id, text);
    if (result && (result.code || result.link)) {
      lastCode.set(accId, { userId: id, emailAt: result.at });
      if (!inWindow) {
        // a free code was used: count it and keep a short window open so a retry doesn't need approval
        o.used++;
        o.until = Date.now() + OTP_WINDOW_MS;
        saveStore();
      }
    } else {
      release();
    }
  } catch (e) {
    console.error(e);
    release();
    const problem = gmailProblem(e);
    if (problem) {
      alertAdmin("gmail-otp", `Gmail error while a customer asked for a code.\n${problem}`);
      bot.sendMessage(msg.chat.id, "The code service is temporarily unavailable. The seller has been notified.");
    } else {
      bot.sendMessage(msg.chat.id, "Something went wrong. Try again shortly.");
    }
  }
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
  delete store.otp[m[1]];
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

// /allow <telegramId> [minutes]  -> let a customer take a code now without asking
bot.onText(/^\/allow(?:@\w+)?\s+(\d+)(?:\s+(\d+))?\s*$/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const mins = m[2] ? Number(m[2]) : Math.round(OTP_WINDOW_MS / 60000);
  const o = (store.otp[m[1]] = store.otp[m[1]] || { used: 0, until: 0 });
  o.until = Date.now() + mins * 60000;
  pendingApproval.delete(Number(m[1]));
  saveStore();
  bot.sendMessage(msg.chat.id, `${m[1]} may request codes for the next ${mins} minute(s).`);
  bot.sendMessage(Number(m[1]), `The seller approved a new code. Request it on Netflix, then send /otp here within ${mins} minutes.`).catch(() => {});
});

// /otpreset <telegramId>  -> back to "first code is free" for this customer
bot.onText(/^\/otpreset(?:@\w+)?\s+(\d+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  delete store.otp[m[1]];
  pendingApproval.delete(Number(m[1]));
  saveStore();
  bot.sendMessage(msg.chat.id, `Code counter reset for ${m[1]}.`);
});

// /expiring [days]  -> customers whose plan ends soon (default 7 days) or already ended
bot.onText(/^\/expiring(?:@\w+)?(?:\s+(\d+))?\s*$/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const days = m[1] ? Number(m[1]) : 7;
  const rows = [...customers.entries()]
    .filter(([, exp]) => exp !== null && exp < Date.now() + days * 86400000)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 60)
    .map(([id, exp]) => `${id}: ${describeExpiry(exp)}${exp < Date.now() ? " (expired)" : ` (${Math.ceil((exp - Date.now()) / 86400000)} day(s) left)`} | login: ${store.assignments[id] || "none"}`);
  bot.sendMessage(msg.chat.id, rows.length ? `Ending within ${days} day(s) or already ended:\n` + rows.join("\n") : `Nobody's plan ends within ${days} day(s).`);
});

// /customer <telegramId>  -> everything about one customer
bot.onText(/^\/customer(?:@\w+)?\s+(\d+)/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const id = Number(m[1]);
  if (!customers.has(id)) return bot.sendMessage(msg.chat.id, "That ID is not a customer.");
  const exp = customers.get(id);
  const accId = store.assignments[id];
  const acc = accId && store.accounts[accId];
  const o = store.otp[id] || { used: 0, until: 0 };
  const left = o.until > Date.now() ? `open for ${Math.ceil((o.until - Date.now()) / 60000)} more minute(s)` : "closed";
  bot.sendMessage(
    msg.chat.id,
    `Customer ${id}\nPlan: ${describeExpiry(exp)}${exp === null ? "" : exp < Date.now() ? " (expired)" : ` (${Math.ceil((exp - Date.now()) / 86400000)} day(s) left)`}\n` +
      `Login: ${acc ? `${accId} (${acc.email})` : "none"}\nCodes given: ${o.used}\nCode approval: ${left}`
  );
});

// /broadcast <text>  -> message every customer with an active plan
bot.onText(/^\/broadcast(?:@\w+)?\s+([\s\S]+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const ids = [...customers.keys()].filter(hasAccess);
  let ok = 0;
  let failed = 0;
  bot.sendMessage(msg.chat.id, `Sending to ${ids.length} customer(s)...`);
  for (const id of ids) {
    try {
      await bot.sendMessage(id, m[1].trim());
      ok++;
    } catch (e) {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 60)); // stay under Telegram's rate limit
  }
  bot.sendMessage(msg.chat.id, `Broadcast done: ${ok} delivered, ${failed} failed (they may have blocked the bot).`);
});

// /gmail  -> test the Gmail connection right now
bot.onText(/^\/gmail(?:@\w+)?\s*$/, async (msg) => {
  if (!isAdmin(msg)) return;
  const problem = await checkGmail();
  bot.sendMessage(msg.chat.id, problem ? `Gmail problem:\n${problem}` : "Gmail access works.");
});

// /admin  -> list of admin commands
bot.onText(/^\/admin(?:@\w+)?\s*$/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      "Customers: /add <id> <days|lifetime>, /remove <id>, /list, /customer <id>, /expiring [days], /broadcast <text>",
      "Logins: /accounts, /addaccount <id> <email> [capacity], /delaccount <id>, /setcap <id> <n>, /unassign <id>, /ready <id>, /setpass <id> <password>",
      "Codes: /allow <id> [minutes], /otpreset <id>, /gmail",
    ].join("\n")
  );
});

// /accounts -> pool overview
bot.onText(/^\/accounts/, (msg) => {
  if (!isAdmin(msg)) return;
  const rows = Object.entries(store.accounts).map(
    ([id, a]) => `${id}: ${a.email} | ${a.status || "ready"} | users ${usersOn(id)}/${a.capacity || 1}`
  );
  bot.sendMessage(msg.chat.id, rows.length ? rows.join("\n") : "No accounts in the pool. Add one with /addaccount <id> <email> [capacity]");
});

// /addaccount <id> <email> [capacity]            (no password needed)
// /addaccount <id> <email> <password> [capacity]  (password only matters for AUTO_RESET)
bot.onText(/^\/addaccount(?:@\w+)?\s+(\S+)\s+(\S+@\S+)(?:\s+(\S+))?(?:\s+(\d+))?\s*$/, (msg, m) => {
  if (!isAdmin(msg)) return;
  const [, id, email, third, fourth] = m;
  let password, cap;
  if (third && /^\d{1,3}$/.test(third) && !fourth) cap = third; // "... email 2" = capacity
  else {
    password = third;
    cap = fourth;
  }
  const capacity = cap ? Math.max(1, Number(cap)) : 1;
  const done = (t) => {
    if (password) bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    bot.sendMessage(msg.chat.id, t);
  };
  if (store.accounts[id]) return done(`Account id "${id}" already exists. Use /delaccount ${id} first, or pick another id.`);
  if (Object.values(store.accounts).some((a) => a.email.toLowerCase() === email.toLowerCase()))
    return done("That email is already in the pool.");
  store.accounts[id] = { email, capacity, status: "ready", ...(password ? { password } : {}) };
  saveStore();
  done(`Added ${id} (${email}), capacity ${capacity}, status ready.` + (password ? " Your message with the password was deleted." : ""));
});
bot.onText(/^\/addaccount(?:@\w+)?\s*$/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, "Usage: /addaccount <id> <email> [capacity]\nExample: /addaccount nf2 name@gmail.com 1\n(A password is optional and only needed for AUTO_RESET: /addaccount nf2 name@gmail.com MyPass 1)");
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

startupNotes.forEach((t) => notifyAdmin(t));
console.log("OTP bot running");
