# Hosting the backend on your own always-on server via Tailscale Funnel

This runs the FastAPI backend (and its 24/7 data collector) on your own Linux
box and exposes **only the API** to the public internet over HTTPS using
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel). The rest of the
machine stays private on your tailnet.

Because the server never sleeps, the background collector keeps polling the LTA
API and the SQLite database accumulates real historical delay data over time.

---

## 1. Get the code on the server

SSH in (Termius) and clone + set up the project:

```bash
git clone https://github.com/Chilitoes/sg-bus-ai.git
cd sg-bus-ai
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Create the .env with your LTA key (used by both the app and systemd)
echo "LTA_API_KEY=PASTE_YOUR_KEY_HERE" > .env
# Optional: pre-seed stops to collect from day one
echo "MONITORED_STOPS=83139,01012,03222,09022" >> .env
```

> The SQLite DB (`bus_data.db`) is written next to `backend/` and persists on
> disk, so history survives restarts and reboots.

---

## 2. Run it as a service (survives reboots/crashes)

```bash
# Edit the two YOUR_USER lines + venv path first:
nano deploy/sg-bus-ai.service

sudo cp deploy/sg-bus-ai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sg-bus-ai

# Verify it's up and serving locally:
systemctl status sg-bus-ai
curl -s http://127.0.0.1:8000/api/model/status
```

---

## 3. Expose the API publicly with Tailscale Funnel

One-time tailnet setup (in the [admin console](https://login.tailscale.com/admin)):

1. **DNS → enable MagicDNS** and **HTTPS Certificates**.
2. Funnel must be allowed for the node. The first `tailscale funnel` command
   below will print a one-click URL to enable it if it isn't already.

Then, on the server:

```bash
# Proxy public https (:443) -> local backend (:8000), in the background,
# persisting across reboots.
sudo tailscale funnel --bg 8000

# Show the public URL:
tailscale funnel status
```

You'll get a URL like:

```
https://<machine-name>.<your-tailnet>.ts.net
```

That URL is your public API base. Test it from any network (e.g. phone on
mobile data):

```
https://<machine-name>.<your-tailnet>.ts.net/api/model/status
```

---

## 4. Point the portfolio at it

In `main-portfolio/bus/app.js`, set:

```js
const API_BASE = "https://<machine-name>.<your-tailnet>.ts.net";
```

(no trailing slash), then merge to `main` to deploy the `/bus` page.

---

## Useful commands

| Command | Purpose |
|---|---|
| `journalctl -u sg-bus-ai -f` | Tail backend logs (watch the collector run) |
| `sudo systemctl restart sg-bus-ai` | Restart after a `git pull` |
| `tailscale funnel status` | Show the public URL / mapping |
| `sudo tailscale funnel --bg off` | Stop exposing publicly |
