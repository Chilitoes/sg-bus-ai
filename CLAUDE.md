# SG Bus AI — Claude Context

## Project overview

SG Bus AI is a PWA at **alstonshi.com/bus** that predicts Singapore bus arrival times using historical LTA data.

Two-repo architecture:
- **`chilitoes/sg-bus-ai`** — FastAPI backend + SQLite DB + background data collector. Also mirrors the frontend in `frontend/` so the backend can serve it directly if needed.
- **`chilitoes/main-portfolio`** — GitHub Pages site; the PWA lives at `bus/` (HTML, CSS, JS). GitHub Actions deploys `main` to alstonshi.com.

## Backend deployment

The backend runs as a **systemd service on the user's own Linux machine** — it is NOT on Fly.io, Railway, Render, or any cloud host.

It binds to `127.0.0.1:8000` and is exposed publicly over HTTPS via **Tailscale Funnel**.

### Redeploy after a backend change

SSH into the Linux machine and run:

```bash
cd ~/sg-bus-ai && git pull origin main && sudo systemctl restart sg-bus-ai
```

### Useful commands

| Command | Purpose |
|---|---|
| `journalctl -u sg-bus-ai -f` | Tail live backend logs |
| `systemctl status sg-bus-ai` | Check service is running |
| `sudo systemctl restart sg-bus-ai` | Restart after a git pull |
| `tailscale funnel status` | Show the public HTTPS URL |

### Service details

- Service file: `/etc/systemd/system/sg-bus-ai.service` (source: `deploy/sg-bus-ai.service`)
- Working directory: `~/sg-bus-ai/backend`
- Venv: `~/sg-bus-ai/.venv`
- Env vars (LTA_API_KEY etc.): `~/sg-bus-ai/.env`
- Port: `8000` (localhost only; Tailscale Funnel proxies HTTPS → 8000)

## Frontend deployment

Frontend changes go in `chilitoes/main-portfolio` under `bus/`. Push to `main` and GitHub Actions deploys automatically. No manual step needed.

When bumping a version:
1. Update `APP_VERSION` in `bus/app.js`
2. Update `CACHE` in `bus/sw.js` (e.g. `sgbus-shell-v1.1.13`)
3. Update `?v=` query strings on `<link>` and `<script>` tags in `bus/index.html`
4. Mirror changes to `sg-bus-ai/frontend/` if they affect the backend-served copy

## Development branch

Active feature branch: `claude/bus-portfolio-page-3yo82i` (both repos)
