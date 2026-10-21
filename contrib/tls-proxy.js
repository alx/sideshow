#!/usr/bin/env node
/**
 * tls-proxy.js — terminate TLS in front of the sideshow Node server.
 *
 * Browsers only allow microphone access (getUserMedia) on **secure
 * contexts**: https:// (or http://localhost). If the viewer is opened via a
 * LAN/tailnet IP over plain http, the push-to-talk button silently falls
 * back to recording the *server's* microphone instead of yours.
 *
 * This script is a pure TLS→TCP tunnel: it terminates TLS with any cert the
 * browser already trusts (Let's Encrypt via `tailscale cert`, Caddy, your
 * own ACME cert, …) and pipes the bytes — untouched — to the sideshow
 * server. No HTTP is parsed, so upgrades, SSE, and large audio uploads all
 * pass through.
 *
 * Usage:
 *   SIDE_CERT=/path/cert.pem SIDE_KEY=/path/key.pem \
 *   BACKEND_PORT=8228 LISTEN_PORT=8443 node contrib/tls-proxy.js
 *
 * Env (all optional, defaults shown):
 *   LISTEN_PORT=8443      port to listen on (bound to 0.0.0.0)
 *   BACKEND_HOST=127.0.0.1
 *   BACKEND_PORT=8228
 *   SIDE_CERT=/path/cert.pem
 *   SIDE_KEY=/path/key.pem
 *
 * ⚠️ PITFALL (cost us a day): never call `socket.setEncoding()` on the
 * tunnel sockets. On Node ≥ 22, `setEncoding(undefined)` makes `data` events
 * emit *strings*; writing those back re-encodes binary payloads as UTF-8,
 * silently corrupting audio uploads (Content-Length mismatch → 400 Bad
 * Request from the server's HTTP parser). Keep the pipe on raw Buffers.
 */
"use strict";

const tls = require("node:tls");
const net = require("node:net");
const fs = require("node:fs");

const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8443);
const BACKEND_HOST = process.env.BACKEND_HOST ?? "127.0.0.1";
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 8228);
const CERT_PATH = process.env.SIDE_CERT ?? "";
const KEY_PATH = process.env.SIDE_KEY ?? "";

if (!CERT_PATH || !KEY_PATH) {
  console.error("tls-proxy: set SIDE_CERT and SIDE_KEY to a PEM cert/key the browser trusts.");
  process.exit(2);
}

const server = tls.createServer(
  {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
    minVersion: "TLSv1.2",
  },
  (client) => {
    const backend = net.connect(BACKEND_PORT, BACKEND_HOST);
    // Raw Buffers only — see the pitfall note above.

    client.on("data", (d) => {
      if (!backend.destroyed) backend.write(d);
    });
    backend.on("data", (d) => {
      if (!client.destroyed) client.write(d);
    });

    const kill = () => {
      client.destroy();
      backend.destroy();
    };
    client.on("error", kill);
    backend.on("error", kill);
    client.on("close", kill);
    backend.on("close", kill);
  },
);

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[tls-proxy] https://*:${LISTEN_PORT} -> ${BACKEND_HOST}:${BACKEND_PORT}`);
});

server.on("error", (e) => {
  console.error(`[tls-proxy] ${e.message}`);
  process.exit(1);
});
