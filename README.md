# Worrkly Lens — Deployment Guide

## What's in this project

```
worrkly-lens/
├── public/
│   └── index.html        ← The full frontend (single page)
├── api/
│   └── analyze.js        ← Serverless backend (Vercel function)
├── package.json          ← Dependencies
├── vercel.json           ← Vercel routing config
└── README.md             ← This file
```

---

## Deploy to Vercel in 5 steps

### 1. Get your Anthropic API key
- Go to https://console.anthropic.com
- Create an account and go to **API Keys**
- Click **Create Key** and copy it (you won't see it again)

### 2. Push this project to GitHub
```bash
# In the worrkly-lens folder:
git init
git add .
git commit -m "Initial commit — Worrkly Lens"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/worrkly-lens.git
git push -u origin main
```

### 3. Connect to Vercel
- Go to https://vercel.com and sign up (free) with your GitHub account
- Click **Add New Project**
- Import your `worrkly-lens` repository
- Click **Deploy** — Vercel auto-detects the config

### 4. Add your API key as an environment variable
- In your Vercel project dashboard, go to **Settings → Environment Variables**
- Click **Add**
  - **Name:** `ANTHROPIC_API_KEY`
  - **Value:** paste your Anthropic key
  - **Environments:** check Production, Preview, Development
- Click **Save**

### 5. Redeploy
- Go to **Deployments** tab
- Click the **⋯** menu on your latest deployment → **Redeploy**
- Wait ~30 seconds — your site is live! ✅

Your URL will be: `https://worrkly-lens.vercel.app` (or your custom domain)

---

## Run locally (optional)

```bash
# Install dependencies
npm install

# Install Vercel CLI globally
npm install -g vercel

# Create a local .env file with your key:
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local

# Start local dev server
vercel dev
# → open http://localhost:3000
```

---

## Custom domain (optional)
- In Vercel project → **Settings → Domains**
- Add your domain (e.g. `lens.worrkly.com`)
- Follow the DNS instructions for your registrar

---

## Cost estimate
| Mode     | Avg tokens | Cost per scan |
|----------|-----------|---------------|
| Text     | ~800      | ~$0.002       |
| Image    | ~1,500    | ~$0.005       |
| Audio    | ~700      | ~$0.002       |
| Code     | ~900      | ~$0.003       |
| Video URL| ~500      | ~$0.001       |

Free tier on Vercel covers unlimited serverless function calls.
Anthropic gives $5 free credit on new accounts (~2,500 free scans).

---

## Rate limiting
The backend limits each IP to **20 requests per minute** to prevent abuse.
You can adjust this in `api/analyze.js` (`RATE_LIMIT` and `RATE_WINDOW`).

---

## Admin Portal — Setup

### Add two more environment variables in Vercel:

| Variable | Description | Example |
|----------|-------------|---------|
| `ADMIN_PASSWORD` | Your admin login password | `MySuperSecret123` |
| `ADMIN_SECRET_KEY` | URL secret key (second factor) | `wl-admin-k7x9p2` |

Both are **required** to access the portal. Set them in Vercel → Settings → Environment Variables, then redeploy.

### Access the portal
Go to: `https://your-site.vercel.app/admin`

You'll see a login screen asking for both credentials.

### What the admin portal shows

- **Total scans** — all-time and today's count
- **Blocked requests** — how many hit the weekly limit
- **Estimated API cost** — calculated from token usage per scan type
- **Active users** — unique IPs seen
- **7-day bar chart** — daily scan volume
- **Scan breakdown by type** — Text / Image / Audio / Code / Video
- **User activity table** — masked IPs, this week's usage, status, reset button
- **Cost breakdown by type** — estimated $ per detection mode
- **System info** — server start time, uptime, totals

### What you can control

- **Change the weekly scan limit** — update from 2 to any number, takes effect immediately
- **Reset all users** — wipes every user's weekly count so they can scan again
- **Auto-refresh** — stats refresh every 30 seconds automatically

### Important note on persistence
The admin stats use in-memory storage, which resets when Vercel spins down the serverless function (cold starts). For permanent persistence, add **Vercel KV** (free tier) and update the store in `api/analyze.js` and `api/admin.js`.
