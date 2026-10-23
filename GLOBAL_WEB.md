# Music By ! A v8 — One Global Web Player for the Fleet

One web listener and one tunnel serve every bot. Signed sessions carry an originating bot identity and resolve playback to the user's live assigned voice room; personal libraries remain user-scoped. `ويب`/`web` sends a private link by DM. Custom `DATA_DIR` stores the persistent signing key alongside the libraries and uploads.

## Default: works outside your LAN automatically

`WEB_PLAYER_GLOBAL_MODE` is `auto`. If no permanent Cloudflare tunnel token is configured, the bot starts a Cloudflare Quick Tunnel to the local Web Player and learns the generated `https://*.trycloudflare.com` URL automatically. Discord Web Player buttons use the live public URL. Public TLS is terminated by Cloudflare, so browsers receive a publicly trusted HTTPS certificate instead of a self-signed certificate.

The local Node origin stays on `127.0.0.1:3780`; you do not need to expose port 3780 on the router. `install.bat` runs `npm run setup:cloudflared`, which downloads the pinned official Cloudflare binary for supported Windows/Linux architectures and verifies its SHA-256 before execution. Startup also performs this check automatically if needed.

## Permanent official hostname

For a stable address such as `https://music.example.com`, create a remotely-managed Cloudflare Tunnel in your own Cloudflare account and route the hostname to `http://127.0.0.1:3780`. Then provide:

- `CLOUDFLARE_TUNNEL_TOKEN` — the tunnel connector token. Prefer an environment variable.
- `WEB_PLAYER_PUBLIC_URL` — the exact public HTTPS hostname, for example `https://music.example.com`.

With both values present and `WEB_PLAYER_GLOBAL_MODE: "auto"`, v8.0.0 automatically uses named-tunnel mode. The hostname remains stable across bot/tunnel restarts. Never publish the tunnel token in a shared source archive.

## Modes

- `auto`: named tunnel when token + public URL exist; otherwise Quick Tunnel.
- `quick`: always use the zero-account temporary HTTPS tunnel.
- `named`: require token + stable public HTTPS URL.
- `manual`: do not spawn cloudflared; assume your own reverse proxy already serves `WEB_PLAYER_PUBLIC_URL`.
- `off`: no managed global gateway.

## Reliability and security

The public side is HTTPS and the origin is loopback-only by default. API calls remain protected by signed private session tokens; the browser moves the initial token to `sessionStorage`, sends API sessions in `X-Music-Session`, and uses `Referrer-Policy: no-referrer`, CSP, HSTS (when seen through the trusted proxy), `X-Frame-Options: DENY`, and other security headers. `cloudflared` is supervised and restarted with backoff if it exits unexpectedly.

A Quick Tunnel is useful because it works with no account or domain, but its public hostname is not permanent and Cloudflare does not provide a production SLA for Quick Tunnels. For a real long-lived official site, use named-tunnel mode with your own domain. Availability can never be guaranteed at an absolute 100% across every ISP/country/device because the host PC, its Internet connection, DNS, browser policies and upstream networks are external dependencies.

## v8.0.0 readiness hardening

The managed gateway no longer declares a tunnel ready just because a process stayed alive for a fixed delay. It waits until cloudflared reports a registered edge connection, retries transient startup failures with bounded exponential backoff, and exposes `/healthz` for uptime checks without requiring or leaking a music session token.

For additional network compatibility, the gateway starts with Cloudflare transport `auto` and can defensively retry with `http2` when an edge connection does not register. This keeps the normal fast path while providing a TCP fallback for restrictive carrier/firewall networks.

If the first set of tunnel attempts fails during startup, v8.0.0 retries Web Player startup every 30 seconds while Discord remains connected. An active tunnel may also restart independently after a later disconnection. The `/healthz` result checks the local application and configured HTTPS address; a separate external request to the actual public hostname is necessary to verify worldwide reachability.
