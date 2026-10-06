# Deploying to Railway

## 1. Push this folder to a GitHub repo
Railway deploys from a git repo. Create a new repo (keep it **private** — `accounts.json`
would contain real passwords if it ever got committed, though `.gitignore` already excludes it)
and push these files:
```
git init
git add .
git commit -m "netflix otp bot"
git branch -M main
git remote add origin <your repo url>
git push -u origin main
```

## 2. Create the Railway project
1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. Railway will see the `Dockerfile` and build from it automatically — you don't need to
   configure anything else here. The `Dockerfile` uses Playwright's own base image, which
   already has Chromium and everything it needs, so `npx playwright install` is not required.

## 3. Attach a Volume (this is the important part)
Railway's filesystem resets on every redeploy. Without a Volume, you'd lose your customer
list, your Netflix account pool, and saved login sessions every time you push an update.

In the Railway dashboard: your service → **Settings** → **Volumes** → **New Volume**.
- Mount path: `/data`
- Any size is fine to start (a few hundred MB).

## 4. Set environment variables
Service → **Variables** → paste these in (see `.env.example` for the full list with comments):

```
TELEGRAM_TOKEN=...
ADMIN_ID=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
DATA_FILE=/data/customers.json
ACCOUNTS_FILE=/data/accounts.json
SESSIONS_DIR=/data/sessions
```

## 5. Turn off the healthcheck
This bot doesn't serve a web port — it just connects out to Telegram and Gmail. Railway's
default healthcheck expects something to respond on a port, so turn it off:
Service → **Settings** → **Healthcheck** → remove/disable it (or set "no healthcheck" if asked).
Also set **Restart Policy** to "On Failure" so Railway restarts it automatically if it crashes.

## 6. Add your first Netflix account to the pool
`accounts.json` isn't something you edit through Railway's UI — the easiest way is a one-off
script, or just edit it locally and upload it once via Railway's shell:

Railway dashboard → your service → **Shell** (or `railway run bash` from the Railway CLI), then:
```
cat > /data/accounts.json << 'EOF'
{
  "accounts": {
    "nf1": { "email": "account1@gmail.com", "password": "xxxx", "capacity": 1 }
  }
}
EOF
```
Add more accounts the same way, or extend this later with an admin command if you'd rather
manage it from Telegram instead of the shell.

## 7. Deploy
Railway deploys automatically on every push to `main`. Watch the **Deploy Logs** — you should
see `OTP bot running` once it's up.

## 8. Test before trusting it with real customers
1. In Telegram, message your bot as the admin: `/add <your_own_telegram_id> lifetime`
2. `/login` — you should get back one of the accounts from `accounts.json`.
3. `/otp` — confirms Gmail is wired up correctly.

## Notes
- Memory: only if you turn on AUTO_RESET does the bot start a Playwright browser (roughly 300–500 MB).
- Logs: `console.error` calls show up in Railway's Deploy Logs — check there first if
  something isn't working.
- Rotating the Google refresh token or Telegram token: just update the Variable and redeploy,
  no code change needed.
