# Contributing

Contributions are welcome when they preserve VaultMind's core safety boundary:
sync materializes ordinary files, models have no arbitrary tools, and every
Vault write is reviewed and restricted.

## Development setup

1. Install Node.js 22 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and use only a disposable test Vault.
4. Run `npm run verify` before submitting a change.

Never develop against the only copy of a real Vault. Do not commit `.env`,
provider keys, Obsidian configuration, chats, drafts, generated indexes, test
output containing note text, or a real Vault fixture.

## Pull requests

Keep changes focused and explain:

- the user-visible outcome and threat-model impact;
- new outbound data flows, filesystem access, or credentials;
- tests for success, failure, cancellation, and path-conflict behavior;
- documentation or migration steps required by operators.

Provider integrations should use the existing adapter boundary. Sync
integrations should materialize a separate local Vault and must not put sync
credentials in the application's accessible Vault view.

By contributing, you agree that your contribution is licensed under the MIT
License and to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
