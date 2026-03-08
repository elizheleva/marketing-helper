# Marketing Helper – Deployment Guide

**Goal:** Push to GitHub → auto-deploy to HubSpot + VPS. No localhost needed after setup.

**Legacy code:** Removed (`firstDealByContact`, `deal_created`, `form_submission`, `closed_won`). Only `meeting_booked` (First-ever meeting) remains.

---

## One-time setup

### 1. GitHub secrets (for auto-deploy)

**Where:** GitHub repo → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:

| Secret | Value |
|--------|-------|
| `HUBSPOT_ACCOUNT_ID` | Your HubSpot portal ID (e.g. `12345678`) |
| `HUBSPOT_PERSONAL_ACCESS_KEY` | [Create one](https://developers.hubspot.com/docs/cms/personal-cms-access-key) for your HubSpot account |
| `VPS_HOST` | `46.202.194.179` |
| `VPS_SSH_KEY` | Full contents of your SSH **private** key (see below) |

**VPS_SSH_KEY setup:** Generate a key pair for deploy, add the **public** key to the server, and put the **private** key in the secret.

**Where:** **PowerShell** (local) – generate key:

```powershell
ssh-keygen -t ed25519 -f deploy_key -N '""'
```

Then:

1. Copy `deploy_key.pub` contents → add to server: **SSH** → `cat >> /root/.ssh/authorized_keys` (paste the line, then Ctrl+D).
2. Copy `deploy_key` (private, no .pub) contents → GitHub secret `VPS_SSH_KEY`.
3. Delete `deploy_key` and `deploy_key.pub` from your machine after.

---

### 2. VPS: ensure repo is cloned

**Where:** Run in **SSH** (after `ssh root@46.202.194.179`)

**Step 2.1** – Check if repo exists:

```bash
ls -la /root/express-api/.git
```

- If you see `.git` → repo is set up. Go to **Step 3**.
- If "No such file" → run **Step 2.2**.

**Step 2.2** – Clone the repo (only if Step 2.1 failed):

```bash
cd /root
mv express-api express-api.bak 2>/dev/null || true
git clone https://github.com/elizheleva/marketing-helper.git express-api
```

**Step 2.3** – Copy data from backup (if you had a previous setup):

```bash
cp -r /root/express-api.bak/data /root/express-api/ 2>/dev/null || true
```

---

### 3. VPS: verify backend has new code

**Where:** **SSH**

**Step 3.1** – Confirm `server.js` has the version endpoint:

```bash
grep "BACKEND_VERSION\|api/version" /root/express-api/server.js
```

Expected: lines with `BACKEND_VERSION` and `/api/version`.

**Step 3.2** – Rebuild and restart:

```bash
cd /root
docker compose build express-api --no-cache
docker compose up -d express-api
```

**Step 3.3** – Check version endpoint:

```bash
curl -s https://api.uspeh.co.uk/api/version
```

Expected: `{"version":"1.1.6"}`.

---

## Ongoing: deploy (after setup)

### Option A – Auto-deploy (no localhost)

1. Edit code locally.
2. Commit and push:

**Where:** **PowerShell** (local)

```powershell
cd c:\Users\neobs\eli-audit-test
git add -A
git commit -m "Your change description"
git push origin main
```

3. GitHub Actions runs and deploys to HubSpot + VPS.
4. Check: [Actions tab](https://github.com/elizheleva/marketing-helper/actions).

---

### Option B – Manual deploy (if Actions fail)

**Where:** **PowerShell** (local)

**Step B.1** – Push to GitHub:

```powershell
cd c:\Users\neobs\eli-audit-test
git add -A
git commit -m "Your change description"
git push origin main
```

**Step B.2** – Deploy to VPS:

```powershell
ssh root@46.202.194.179 "cd /root/express-api && git pull origin main && cd /root && docker compose build express-api --no-cache && docker compose up -d express-api"
```

**Step B.3** – Deploy to HubSpot (if needed):

```powershell
cd c:\Users\neobs\eli-audit-test
hs project upload
```

---

## Quick reference: where to run commands

| Command type | Where |
|--------------|-------|
| `git add`, `git commit`, `git push` | **PowerShell** (local) |
| `ssh root@46.202.194.179` | **PowerShell** (local) |
| `curl`, `docker compose`, `grep`, `git pull` on server | **SSH** (after SSH in) |
| `hs project upload` | **PowerShell** (local, if manual HubSpot deploy) |

---

## Verify deployment

- **Backend:** https://api.uspeh.co.uk/api/version → `{"version":"1.1.6"}`
- **HubSpot:** Open Marketing Helper settings in HubSpot, run Paths report.
- **Legacy error:** Should be gone. If you still see `firstDealByContact`, the VPS is running old code – rerun Step 3.
