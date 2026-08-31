# Security policy

## Supported versions

Security fixes are applied to the latest release on the `main` branch. This
project is pre-1.0; older snapshots are not maintained as separate supported
release lines.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include
private Vault content, credentials, logs, or exploit details in a discussion.
Use GitHub's private vulnerability reporting / Security Advisory feature for
this repository. Include the affected revision, deployment shape, impact,
minimal reproduction, and any suggested mitigation.

If private reporting is not enabled, open a public issue containing only a
request for a private contact channel—do not include the vulnerability itself.

You should receive an acknowledgement within seven days. A fix timeline
depends on severity and reproducibility. Please allow a reasonable remediation
window before public disclosure.

## Operator security

Second-Mind handles private notes and can write into configured Vault folders.
Before deployment, read [docs/security.md](docs/security.md),
[docs/networking.md](docs/networking.md), and
[docs/data-flow.md](docs/data-flow.md). In particular, keep the application on
loopback/private networking, use HTTPS, protect `DATA_DIR` like the Vault, and
understand what a remote model or embedding provider receives.
