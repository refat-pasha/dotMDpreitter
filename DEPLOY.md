# Publishing dotMDpritter

Everything below assumes you are deploying the **whole app**, not just the
page. Read the first section — it is the part people get wrong.

---

## 1. Read this first: what you can and cannot host

dotMDpritter is a **stateful server**. It has to be a long-running Node process
with a **writable disk that survives restarts**, because that disk holds:

- `data/users.json` — every account
- `data/sessions.json` — active sessions
- `data/users/<userId>/…` — every user's `.md` files, in real folders

### Will not work

| Platform | Why |
|---|---|
| GitHub Pages | Static files only, no server |
| Cloudflare Pages / Netlify (static) | Same — no long-running process |
| Vercel / Netlify **serverless** | Ephemeral filesystem; accounts and files vanish on every redeploy and cold start. No persistent writable disk. |
| Any host without a volume | Same problem, quieter |

### Will work

| Option | Persistent disk | Difficulty |
|---|---|---|
| **Docker** on a VPS | you provide it | easiest to reason about |
| **Railway** | volume, a few clicks | easiest overall |
| **Render** (paid) | disk | easy |
| **Fly.io** | volume | easy |
| **DigitalOcean App Platform** | volume | easy |
| **VPS + systemd + nginx** | you provide it | most control, best for real use |

### The three settings that matter

| Variable | Default | Why |
|---|---|---|
| `DOTMD_DATA` | `./data` | **Must** point at a persistent volume. Get this wrong and every deploy deletes every user's files. |
| `PORT` | `4173` | Injected automatically by most PaaS platforms. |
| `DOTMD_SECURE` | `0` | Set to `1` behind HTTPS. **Optional** — the app also reads `X-Forwarded-Proto`, so TLS-terminating proxies are detected automatically. Verified both ways. |

There are **no secrets to configure.** No API keys, no database URL, no
`SESSION_SECRET` — sessions are random tokens stored server-side, so there is
nothing to leak or rotate.

The one optional extra is SMTP, used only by "Forgot your password?":

| Variable | Default | Purpose |
|---|---|---|
| `DOTMD_SMTP_HOST` | — | e.g. `smtp.gmail.com` |
| `DOTMD_SMTP_PORT` | `587` | `587` STARTTLS, `465` implicit TLS |
| `DOTMD_SMTP_USER` | — | username or API key |
| `DOTMD_SMTP_PASS` | — | password or API secret |
| `DOTMD_MAIL_FROM` | `dotMDpritter <no-reply@localhost>` | envelope sender |
| `DOTMD_PUBLIC_URL` | derived from the request | set this behind a proxy so the emailed link points at the public address |

Leave them unset and password recovery still works: the reset link is printed
in the server log instead of being emailed.

### Scale honestly

This runs as **one process**. The rate limiter is in memory and the store is a
JSON file, so two instances would fight. For more than one instance, put a
sticky load balancer in front *and* move `server/db.js` to a real database
first. For a team or a family this is a non-issue.

---

## 2. Docker (recommended)

```bash
docker build -t dotmdpritter .

docker run -d \
  --name dotmdpritter \
  -p 4173:4173 \
  -v dotmd-data:/data \
  -e DOTMD_DATA=/data \
  --restart unless-stopped \
  dotmdpritter
```

The named volume `dotmd-data` is what makes accounts and files survive
`docker rm` and redeploys. **Do not skip it.**

Check it is alive:

```bash
curl http://localhost:4173/api/health
# {"ok":true,"uptime":12,"writable":true}
```

`writable:false` means the volume is not writable — nothing will be saved. The
`HEALTHCHECK` in the Dockerfile uses this same endpoint, so orchestrators will
restart the container.

### With Docker Compose

```yaml
services:
  dotmdpritter:
    build: .
    ports: ["4173:4173"]
    volumes: ["dotmd-data:/data"]
    environment:
      DOTMD_DATA: /data
    restart: unless-stopped

volumes:
  dotmd-data:
```

### Behind a reverse proxy

Terminate TLS in Caddy, nginx or Traefik and forward to port
4173. All of them send `X-Forwarded-Proto`, so the session cookie gets the
`Secure` flag automatically.

---

## 3. Railway

1. `railway init` in the project folder, or **New Project → Deploy from GitHub**.
2. Railway detects the `Dockerfile` automatically. (A `Procfile` is also present
   if you prefer the Node builder — it runs `node server.js`.)
3. **Add a volume**: right-click the service → *Volumes* → *Add Volume*, mount
   path **`/data`**.
4. Set `DOTMD_DATA=/data`.
5. **Generate a domain**: Settings → Networking → *Generate Domain*. Railway
   terminates TLS, so the `Secure` cookie flag works with no extra env var.
6. Health check path: `/api/health`.

Railway's filesystem is ephemeral outside volumes, so **step 3 is the one that
protects your data.**

## 4. Render

1. New → *Web Service* → connect the repo.
2. Environment **Node**. Build command *(leave empty)*. Start command
   `node server.js`.
3. **Add a disk** under *Disks*, mount path `/data`, size 1 GB+.
4. Environment variables: `DOTMD_DATA=/data`.
5. Render terminates TLS. Health check path: `/api/health`.

Disks are **paid** on Render; the free tier has no persistent storage, so
accounts and files will not survive a restart.

## 5. Fly.io

```bash
fly launch --no-deploy --name dotmdpritter
fly volumes create dotmd_data --size 1     # 1 GB
fly deploy
fly secrets set DOTMD_DATA=/data
```

Then attach the volume in your `fly.toml`:

```toml
[[mounts]]
  source = "dotmd_data"
  destination = "/data"
```

```bash
fly ips allocate-v6     # or attach a domain
fly domains add your-domain.com
```

Set the health check path to `/api/health`. **One instance only** — `fly scale`
must stay at 1 (see the scale note above).

## 6. VPS (systemd + nginx) — the full-control option

```bash
# 1. A dedicated unprivileged user
sudo useradd --system --home /var/lib/dotmdpritter --shell /usr/sbin/nologin dotmd

# 2. The app
sudo mkdir -p /opt/dotmdpritter
sudo cp -r . /opt/dotmdpritter
cd /opt/dotmdpritter
sudo chown -R dotmd:dotmd /opt/dotmdpritter /var/lib/dotmdpritter

# 3. Service
sudo cp deploy/dotmdpritter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dotmdpritter
sudo systemctl status dotmdpritter

# 4. Reverse proxy + TLS
sudo apt install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/dotmdpritter
sudo ln -s /etc/nginx/sites-available/dotmdpritter /etc/nginx/sites-enabled/
sudo sed -i 's/notes.example.com/your-domain.com/g' /etc/nginx/sites-available/dotmdpritter
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

`deploy/nginx.conf` already sends `X-Forwarded-Proto`, rate-limits
`/api/auth/*` to 10 requests/minute per IP, and refuses to cache the API. The
systemd unit is hardened (`ProtectSystem=strict`, only `/var/lib/dotmdpritter`
writable) and handles `SIGTERM` so data is flushed on stop.

Logs: `journalctl -u dotmdpritter -f`

---

## 7. Backups

`data/` is the only thing that matters, and losing it loses every account and
every file. Back it up on a schedule:

```bash
node backup.js                              # → backups/dotmd-<stamp>.tar.gz
node backup.js --restore backups/dotmd-<stamp>.tar.gz
```

Backup archives the *contents* of the data directory, and restore **moves the
current directory aside** rather than extracting over it. That matters: `tar`
overwrites but never deletes, so an in-place restore would silently leave files
created after the snapshot behind and would not actually roll back. The
previous directory is kept as `data.replaced-<stamp>/` until you delete it, and
a failed extraction is rolled back automatically. Both behaviours are tested.

Cron (daily at 03:17 — off the hour on purpose):

```cron
17 3 * * * cd /opt/dotmdpritter && /usr/bin/node backup.js >> /var/log/dotmd-backup.log 2>&1
```

Then copy `backups/` off the machine. A backup on the same disk is not a backup.

---

## 8. After you deploy — checklist

- [ ] `curl https://your-domain/api/health` → `{"ok":true,…,"writable":true}`
- [ ] Sign in over **https**, confirm the cookie carries `Secure`
- [ ] Save a file in a folder, then restart the service — **it is still there**.
      If it is gone, the volume is not mounted. Fix that first.
- [ ] `https://your-domain/data/users.json` returns **404**
- [ ] Schedule `backup.js` and copy the archive off-machine
- [ ] Register a throwaway account, then delete it, to confirm signup works
- [ ] `npm test` locally once more after any change (324 assertions)

## 9. Operational limits to be aware of

- **One instance.** In-memory rate limiter, JSON store. Scale = 1.
- **No email verification or password reset** — no mail transport. Self-service
  recovery needs an email provider and a token table.
- **Last write wins.** Two browsers editing the same cloud file overwrite each
  other; no merge, no version history.
- **Rate limits are per instance and in memory**, so a restart resets them.
  `deploy/nginx.conf` adds a proxy-level layer for `/api/auth/*`.
- **The JSON store is not a database.** Fine for tens of users; swap
  `server/db.js` for SQLite before thinking about thousands.
- **Back up before every upgrade.** There is no schema migration.

