# Pi implementation history

These source files, tests and evaluation tools belong to the previous Pi / research implementation. They are retained for review and rollback analysis. The production application, container, installer and active test runner do not load them.

The replacement is `src/original/knowledge-agent.mjs`, wrapped by `src/sdk-knowledge-manager.mjs`, with the original knowledge store, index, task modes, learning review and UI. Active verification includes `test/original/` and `test/sdk-*.test.mjs`.

`manifest.json` records every moved path. Relative module imports were adjusted to preserve references. This archive is not a supported runtime or a current acceptance suite; some tests refer to shared modules whose interfaces have since changed. The original pre-migration checkout and private data were backed up outside the repository before implementation.
