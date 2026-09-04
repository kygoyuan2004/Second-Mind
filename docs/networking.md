# Networking and remote access

Second Mind handles private notes and administrator credentials. Compose publishes only to `127.0.0.1` by default. Keep that boundary unless a reviewed private network or HTTPS reverse proxy protects remote traffic.

Do not expose the application port directly to the public internet.

## Default local topology

```text
browser on host -> http://127.0.0.1:PORT -> Docker published port -> app:8787
```

The application container listens on `0.0.0.0:8787`, but the host publication is controlled by:

```dotenv
VAULTMIND_BIND_IP=127.0.0.1
VAULTMIND_PORT=8787
```

The `VAULTMIND_*` names are Compose compatibility identifiers. The installer generates them in private instance configuration and verifies that it does not displace a process already using the port.

## Private-network access

A private overlay network with an authenticated HTTPS serving feature is the preferred remote pattern for personal use:

```text
remote browser -> private overlay identity and TLS -> loopback proxy -> Second Mind
```

Keep the Compose bind on loopback. Configure the serving layer to proxy to that loopback port, preserve the public host, replace forwarding headers, and support streaming responses. Set:

```dotenv
SECURE_COOKIE=true
TRUST_PROXY=true
```

Only set `TRUST_PROXY=true` when clients cannot reach the application except through that trusted proxy. Never enable a public-tunnel or public-sharing feature for this service unless a separate security review explicitly accepts the exposure.

Review the private-network vendor's current authentication, certificate, ACL, device, and logging behavior. Network membership does not replace the Second Mind password or host hardening.

## HTTPS reverse proxy

The repository includes templates for Caddy and Nginx under `deploy/`. Replace every placeholder and validate the complete configuration on the target host.

Required proxy behavior:

- terminate maintained TLS and redirect HTTP to HTTPS;
- preserve the public `Host` header used by same-origin checks;
- replace, not append to, `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`;
- disable buffering/caching for SSE and use timeouts long enough for bounded Deep tasks;
- apply a request-body limit consistent with `MAX_JSON_BODY_BYTES`;
- rate-limit `/api/login` at the edge;
- keep the upstream on loopback and prevent direct bypass;
- omit request bodies, cookies, authorization headers, and URL secrets from logs.

Application settings behind HTTPS:

```dotenv
HOST=127.0.0.1
SECURE_COOKIE=true
TRUST_PROXY=true
```

For Docker, `HOST` is intentionally `0.0.0.0` inside the isolated container; the host-side bind remains `127.0.0.1`.

`deploy/Caddyfile.example` and `deploy/nginx.conf.example` show the required streaming and forwarding shape. They are templates, not complete certificate, DNS, firewall, observability, or intrusion-response configurations.

## Direct LAN binding

Setting `VAULTMIND_BIND_IP=0.0.0.0` makes the selected port reachable on every host interface allowed by the firewall. Plain HTTP then exposes login and private note traffic to the network and should not be used on an untrusted LAN.

If a controlled environment temporarily requires direct binding:

1. restrict the host firewall to exact source subnets/devices;
2. keep `TRUST_PROXY=false` unless a real proxy is present;
3. use a host-level TLS terminator as soon as possible;
4. verify from an unauthorized network that the port is unreachable;
5. return to loopback after the test.

Do not use a broad bind to work around proxy or container connectivity problems.

## Origin and session behavior

All mutating API calls require `X-VaultMind-Request: 1`. If a browser sends `Origin`, its host must match the HTTP `Host`. A proxy that rewrites `Host` incorrectly causes legitimate writes to fail. A proxy that trusts client-supplied forwarding headers can corrupt login-throttling identity.

The session cookie is HttpOnly and SameSite=Strict. It has `Secure` only when `SECURE_COOKIE=true`. That setting is required behind HTTPS, but it will prevent the cookie from working over plain HTTP during a local test.

## Provider egress

The application can make outbound connections only for configured operations:

- selected LLM generation and explicit validation;
- embedding validation/build and semantic queries;
- explicitly enabled Q&A WebSearch;
- selected public HTTPS page reading;
- an independent external sync process.

Apply destination allowlists, DNS monitoring, quotas, and cost alerts when the hosting platform supports them. The safe page reader performs application-level SSRF checks, but host firewall policy remains a separate defense.

Blocking Provider egress does not prevent local startup or BM25 search. It can make generation, semantic queries, validation, or WebSearch fail explicitly.

## Firewall and verification checklist

Before enabling remote access:

1. Confirm the app port is bound only where intended with host networking tools and `docker compose port`.
2. Confirm `/health/live` and `/health/ready` work through the chosen proxy.
3. Confirm login, logout, mutations, file previews, and long SSE tasks work through the public hostname.
4. Confirm an invalid `Origin` is rejected and the proxy replaces spoofed forwarding headers.
5. Confirm cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` on HTTPS.
6. Confirm unauthenticated API requests return `401` and that login throttling exists at both app and edge.
7. Confirm only intended Provider/search/page destinations can leave the host.
8. Confirm proxy and application logs do not contain prompts, note bodies, cookies, or keys.
9. Confirm backups remain private and a restore can be tested without opening a public port.

See [security.md](security.md) for the complete trust model and [data-flow.md](data-flow.md) for operation-specific egress.
