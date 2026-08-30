# Networking and remote access

VaultMind contains private notes, prompts, generated drafts, and account
sessions. Its application port is not a public security boundary. The default
Compose mapping is intentionally:

```text
127.0.0.1:8787 -> container:8787
```

Choose one reviewed access path below. Do not change the mapping to
`0.0.0.0:8787` merely to make the service reachable.

## Recommended: Tailscale Serve

Tailscale Serve terminates HTTPS and makes the service reachable only inside
the tailnet. It is the simplest option for a personal server without opening a
router port.

1. Install Tailscale on the server and client devices.
2. Enable MagicDNS and HTTPS for the tailnet.
3. Keep VaultMind bound to `127.0.0.1`.
4. Restrict access to the server and service in the tailnet policy.
5. Set these non-secret application values before restarting:

   ```dotenv
   TRUST_PROXY=true
   SECURE_COOKIE=true
   ```

6. Publish the loopback service persistently:

   ```bash
   tailscale serve --bg 127.0.0.1:8787
   tailscale serve status
   ```

Use the HTTPS `*.ts.net` URL reported by Tailscale. Review the current
[Tailscale Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
because syntax can change between client releases.

### Do not use Funnel

Tailscale Funnel intentionally exposes a service to the public internet. It is
not required for this architecture and must remain disabled. Serve and Funnel
are different products: seeing a valid `*.ts.net` certificate does not by
itself prove that access is tailnet-only. Verify `tailscale serve status` and
the tailnet policy after every networking change.

Keep VaultMind's own password even when Tailscale controls network membership.
Tailnet membership and application authentication protect different failure
modes.

## Cloud server with Caddy

For a public cloud host, use a dedicated DNS name, Caddy-managed HTTPS, a host
firewall, and the application login. Do not serve the origin on its raw IP and
port.

1. Keep VaultMind on `127.0.0.1:@PORT@`.
2. Point the chosen DNS record at the server.
3. Allow inbound TCP 80/443 only; keep 8787 blocked externally.
4. Render `deploy/Caddyfile.example` with the domain and local port.
5. Set `TRUST_PROXY=true` and `SECURE_COOKIE=true`.
6. Validate and reload Caddy.

The example limits request bodies, disables identifying response headers, sets
HSTS, preserves streaming responses, and replaces forwarding headers rather
than trusting values supplied by the client.

Only enable HSTS after the domain works correctly over HTTPS. The example uses
`includeSubDomains`; remove it if unrelated subdomains are not HTTPS-ready.

## Cloud server with Nginx

`deploy/nginx.conf.example` provides the same loopback reverse-proxy model and
adds an edge login rate limit. Replace the domain, certificate, private-key,
and port placeholders, include the rendered snippet inside Nginx's existing
`http {}` context, then run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Obtain certificates through a maintained ACME client and automate renewal.
Private keys must be readable only by the TLS service. The Nginx example turns
off proxy buffering and raises read timeouts because model responses use
server-sent events and can run for several minutes.

## Trusted proxy setting

`TRUST_PROXY=true` makes login rate limiting use the first
`X-Forwarded-For` value. Enable it only when:

- VaultMind listens on loopback or a private container network; and
- every request must pass through a proxy that deletes and recreates forwarding
  headers.

If clients can reach the application port directly, they can forge that header
and evade or poison IP-based limits. Leave `TRUST_PROXY=false` for direct local
HTTP access.

`SECURE_COOKIE=true` is required for HTTPS. A Secure cookie is not sent to a
plain `http://` URL, so local HTTP diagnostics may need a separate temporary
configuration. Never leave it disabled on an HTTPS production deployment.

## Direct LAN access

Plain HTTP on a shared LAN exposes passwords, session cookies, questions, and
note content to network observers. A home or office LAN is not automatically a
trusted security boundary.

Prefer Tailscale Serve. If a constrained LAN deployment is unavoidable, bind
the host mapping to one explicit private address rather than `0.0.0.0`, use a
local HTTPS reverse proxy, and firewall the port to a small source subnet. Do
not configure router port forwarding or UPnP.

## Provider egress

The application also makes outbound requests to model and optional embedding
providers:

| Endpoint | Outbound data | Recommended transport |
|---|---|---|
| `LLM_API_BASE` | Prompt, recent chat history, retrieved note excerpts, text attachment excerpts | HTTPS, or loopback/local Docker only |
| `EMBEDDING_API_BASE` / `EMBEDDING_ENDPOINT` | Indexed document chunks and search queries | HTTPS, or loopback/local Docker only |
| Obsidian Headless | Vault changes and Sync metadata | Upstream encrypted Sync protocol |

Keep `ALLOW_INSECURE_PROVIDER_HTTP=false`. The application permits HTTP for
`localhost`, loopback addresses, and `host.docker.internal`; any other HTTP
endpoint requires an explicit opt-in. If a model runs on another Tailscale
node, use a tailnet ACL that allows only the VaultMind server to reach that
model port and prefer HTTPS or an authenticated service identity.

Provider API keys belong in file-backed secrets, never URL query parameters.
Restrict each key by project, quota, and provider permissions. An embedding key
should not inherit broader model or account privileges merely for convenience.

## Firewall and verification checklist

- The application listens only on loopback or an internal container network.
- Only the chosen HTTPS proxy is reachable from clients.
- Port 8787 is not present in public security groups or router forwarding.
- Tailscale Funnel is disabled.
- `SECURE_COOKIE=true` on HTTPS.
- `TRUST_PROXY=true` only with an exclusive trusted proxy.
- TLS certificates renew automatically and weak protocols are disabled.
- Provider endpoints use expected hostnames and HTTPS.
- Access logs do not record cookies, authorization headers, request bodies, or
  URL-carried secrets.
- A test from outside the intended network cannot reach the service.
