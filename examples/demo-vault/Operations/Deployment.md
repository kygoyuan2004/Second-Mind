# Private deployment

The web service listens on loopback by default. Tailscale Serve can terminate HTTPS and expose the loopback service only to an authorized tailnet.

For a public cloud deployment, place Caddy or Nginx in front of the app, expose only port 443, enable secure cookies, and keep the internal application port behind a firewall.

API keys belong in server-side secret files or a secret manager. They must never be stored in browser local storage or committed with the Vault.
