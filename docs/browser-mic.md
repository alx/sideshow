# Browser microphone (push-to-talk) over HTTPS

The viewer's **push-to-talk** button records the microphone of the device
_viewing_ the surface — but only when the page is served from a **secure
context**. Browsers restrict `getUserMedia` to `https://` (or
`http://localhost`). If you open the viewer on a LAN/tailnet IP over plain
`http://`, the button detects this and silently falls back to capturing the
**server's** microphone instead of yours (a short hint appears in the button).

To get your own mic, serve the same sideshow instance over HTTPS and open that
URL.

## Option A — a TLS-terminating proxy in front of the Node server (simplest)

`contrib/tls-proxy.js` is a dependency-free TLS→TCP tunnel: it terminates TLS
with a cert your browser already trusts and pipes the bytes — untouched — to
the running sideshow server. No HTTP is parsed, so audio uploads, SSE and any
future WebSocket upgrades all pass through.

1. Get a cert for the hostname you'll browse to. For a tailnet machine,
   `tailscale cert <hostname>.<tailnet>.ts.net` provisions a **Let's Encrypt**
   cert (requires HTTPS enabled in the tailnet's admin console). Any ACME cert
   works; what matters is that the _browser_ trusts it, not that tailscaled
   does.
2. Run the tunnel against the local server:

   ```sh
   SIDE_CERT=~/<hostname>.ts.net.crt \
   SIDE_KEY=~/<hostname>.ts.net.key \
   BACKEND_HOST=127.0.0.1 BACKEND_PORT=8228 \
   LISTEN_PORT=8443 \
   node contrib/tls-proxy.js
   ```

3. Open **`https://<hostname>.<tailnet>.ts.net:8443/`** (or `:8443` on whatever
   port you chose), allow the mic prompt, hold the button, talk.

The tunnel is stateless and cheap; run it as a service next to sideshow.
systemd user unit example:

```ini
# ~/.config/systemd/user/sideshow-tls.service
[Unit]
Description=sideshow TLS tunnel (:8443 -> :8228)
After=network-online.target

[Service]
ExecStart=/usr/bin/env node /path/to/sideshow/contrib/tls-proxy.js
Environment=LISTEN_PORT=8443
Environment=BACKEND_HOST=127.0.0.1
Environment=BACKEND_PORT=8228
Environment=HOME=/home/you
Environment=SIDE_CERT=/home/you/lamai.ts.net.crt
Environment=SIDE_KEY=/home/you/lamai.ts.net.key
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now sideshow-tls
```

Notes:

- **Cert renewal.** `tailscale cert` files are not renewed automatically;
  re-run `tailscale cert <host>` before expiry and restart the tunnel
  (`systemctl --user restart sideshow-tls`). Caddy or nginx with ACME
  automation are fine too, if you prefer a managed path.
- **Port choice.** Anything works (`:8443`, `:443` via your own nginx/Caddy,
  …). The browser only cares that the scheme is `https` and the cert is
  trusted for the hostname in the URL bar.
- **Keep the tunnel a pure byte pipe.** Do not add `setEncoding()` on the
  sockets — on Node ≥ 22 that makes `data` events emit strings and silently
  corrupts binary uploads (see the warning at the top of
  `contrib/tls-proxy.js`).
- **Troubleshooting a `400 Bad Request` on release:** you're hitting a
  corrupted-upload symptom from a middlebox or proxy that re-encodes bodies.
  Verify with
  `curl -sk -X POST https://<host>:8443/api/voice/start -d '{"capture":"client"}'`
  then
  `curl -sk -X POST https://<host>:8443/api/voice/stop --data-binary @sample.webm -H 'content-type: audio/webm'`
  — both must return `201`/`202`.

## Option B — terminate TLS in a real reverse proxy

Any TLS-terminating reverse proxy works the same way: point the server block
at `http://127.0.0.1:8228`, install a trusted cert (Caddy `internal`/ACME,
nginx + certbot, Caddy with `tailscale` package, …). Then open
`https://<your-host>/`. Use this when the machine already runs such a proxy;
use Option A when you don't want to install anything.

## Option C — Tailscale Serve HTTPS

`tailscale serve 8228` advertises `https://<host>.<tailnet>.ts.net/` using
tailscaled's own TLS. On most setups this is the zero-config path; on some
nodes the built-in `:443` handler misbehaves (TLS `internal error` alert at
handshake even with a valid `tailscale cert`), in which case use Option A on
an alternate port — the viewer does not care which port, only that it is
`https`.

## What you get

Once the page is `https`, holding push-to-talk records a WebM/Opus take in the
browser, uploads it to `POST /api/voice/stop`, and the server decodes it,
transcribes it (local STT) and publishes the audio + transcript card. The
legacy server-mic capture remains the automatic fallback for insecure
origins.
