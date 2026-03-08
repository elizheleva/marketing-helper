# GitHub Actions Deploy – Troubleshooting

If workflow runs fail (red X), follow these steps.

## 1. See the actual error

1. Go to https://github.com/elizheleva/marketing-helper/actions
2. Click on the **most recent failed run**
3. Expand the failed job: **Deploy to HubSpot** or **Deploy to VPS**
4. Read the error message at the bottom of the log

## 2. HubSpot job failures

**Required secrets:** `HUBSPOT_ACCOUNT_ID`, `HUBSPOT_PERSONAL_ACCESS_KEY`

| Error | Fix |
|-------|-----|
| "Missing account" / "Invalid credentials" | Add or fix secrets in repo Settings → Secrets and variables → Actions |
| "HUBSPOT_ACCOUNT_ID" not found | Add secret: your portal ID (e.g. `47875486`) |
| "Personal access key" invalid | Create a new [personal access key](https://developers.hubspot.com/docs/cms/personal-cms-access-key) with CMS/developer scope. Use the **private** key value. |
| build_id empty / deploy fails | The upload step may have failed. Check the Upload step log above it. |

## 3. VPS job failures

**Required secrets:** `VPS_HOST`, `VPS_SSH_KEY`

| Error | Fix |
|-------|-----|
| "secret VPS_HOST not found" | Add secret: `46.202.194.179` |
| "secret VPS_SSH_KEY not found" | Add the full private key (including `-----BEGIN...` and `-----END...` lines) |
| "Permission denied (publickey)" | Ensure the **public** key is in `~/.ssh/authorized_keys` on the VPS. Regenerate: `ssh-keygen -t ed25519 -f deploy_key -N '""'` |
| "No such file or directory" /root/express-api | SSH to VPS and clone: `cd /root && git clone https://github.com/elizheleva/marketing-helper.git express-api` |
| "docker compose" not found | Install Docker on the VPS |
| "service express-api not found" | Ensure `/root/docker-compose.yml` exists and defines a service named `express-api` |

## 4. Verify secrets

Repo → **Settings** → **Secrets and variables** → **Actions**. You should have:

- `HUBSPOT_ACCOUNT_ID`
- `HUBSPOT_PERSONAL_ACCESS_KEY`
- `VPS_HOST`
- `VPS_SSH_KEY`

## 5. Manual deploy (workaround)

Until the workflow succeeds, deploy manually:

**HubSpot (PowerShell):**
```powershell
cd c:\Users\neobs\eli-audit-test
hs project upload
hs project deploy
```
(Select the latest build when prompted.)

**VPS (PowerShell):**
```powershell
ssh root@46.202.194.179 "cd /root/express-api && git pull origin main && cd /root && docker compose build express-api --no-cache && docker compose up -d express-api"
```
