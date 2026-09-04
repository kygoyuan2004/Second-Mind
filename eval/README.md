# Retrieval evaluation

`demo-dataset.json` is synthetic and exists only to exercise the evaluation pipeline. Replace it with a private, human-reviewed dataset whose `relevantPaths` point to your own Vault. Do not commit private questions or note paths.

Run lexical evaluation against the included demo Vault:

```bash
VAULT_PATH=examples/demo-vault EMBEDDING_PROVIDER=disabled npm run eval -- --k 3 --min-recall 1
```

The included three-query synthetic baseline currently reports Recall@3 `1.0000`,
MRR `0.8333`, and nDCG@3 `0.8770`. These values only verify that the evaluation
pipeline is reproducible; they do not measure production retrieval quality.

The report includes Recall@K, mean reciprocal rank, and nDCG@K. When a remote
Embedding provider is enabled, evaluation sends the indexed fixture text and
queries to that provider.

## Private Agent-versus-RAG benchmark

The separate `npm run benchmark -- <command>` CLI implements the guarded
four-command workflow used for a private, human-reviewed comparison:

- `prepare` verifies a pinned backup manifest, reproduces the text/secret
  filtering policy, and pins the read-only snapshot provenance.
- `validate` checks the 48-question distribution, review state, evidence line
  ranges and hashes, secret patterns, source manifest, and snapshot manifest.
- `run` currently accepts only explicitly supplied offline result JSON. It
  refuses model execution and refuses an unapproved dataset.
- `report` emits an aggregate-only anonymous JSON DTO.

The runtime building blocks are deliberately dependency-injected and covered by
synthetic tests: `benchmark-runtime.mjs` supplies the loopback model proxy and
budget ledger, `benchmark-systems.mjs` wraps the original Agent and migrated RAG
logic, and `benchmark-scheduler.mjs` implements paired calibration, deterministic
ordering, and the ¥90/¥100 downgrade gates. None of these modules reads a live
Vault or production service socket by default.

`benchmark-production-guard.mjs` captures the two production service identities
and the loopback home/knowledge HTTP status before and after an execution. A PID,
start-time, restart-count, active-state, or HTTP-200 change fails the guard. Both
system runners separately reject a snapshot or state directory that overlaps the
configured live Vault.

Never commit the private dataset, review sheet, raw answers, provider key, or
result records. A dataset is runnable only after its top-level review status and
every question review status are both `approved` and its byte digest still
matches the reviewed artifact.

## Private 30-question completeness baseline

`npm run eval:completeness30` is a separate, offline-first source-coverage
entry point for a private 30-question completeness set. The questions and full
gold rubric stay outside the repository. The generated report is owner-only
under `.local/` and contains only question numbers, logical-document gold
coverage, MRR, nDCG, latency, and explicit comparability status. It never emits
question text, answer text, note paths, retrieved snippets, or candidate names.

The evaluator scores logical documents: an original note and its organized
variant occupy one gold slot. It reads an existing index without rebuilding it
and does not initialize any network provider. A lexical baseline can therefore
run entirely offline:

```bash
npm run eval:completeness30 -- \
  --questions /absolute/private/questions-clean.md \
  --gold /absolute/private/questions-with-gold.md \
  --vault /absolute/read-only/vault-snapshot \
  --index /absolute/read-only/migration-index \
  --mode keyword
```

True hybrid evaluation additionally requires `--query-vectors` pointing to an
owner-only cache produced during a separately authorized embedding run. The
cache contains query hashes and vectors, not question text. Without a complete
cache matching the persisted index provider, model, and dimensions, the command
fails closed with `QUERY_VECTORS_REQUIRED_OFFLINE`; it never labels a keyword
fallback as hybrid.

This entry point deliberately marks the original-system side as
`ORIGINAL_OFFLINE_ADAPTER_NOT_CONFIGURED`. A fair system comparison requires a
separate pinned Vault snapshot and index for each implementation, the same
logical gold mapping and K values, warm and cold latency reported separately,
and a read-only original adapter proven not to overlap production state. Do not
run either implementation against its live service or modify/rebuild the
original system merely to obtain a score.

### Offline blind adjudication

After a full cloud execution has safely published its final summary, create two
private blind-review packets with:

```bash
npm run benchmark:adjudicate -- prepare \
  --cloud-run /absolute/private/cloud-run \
  --dataset /absolute/private/approved-dataset.json \
  --output-root /absolute/private/blind-review
```

`prepare` opens `cloud-execution-summary.json` first and refuses to open any raw
record unless the run is complete, non-calibration-only, has no uncertain/open
budget reservation, and reports unchanged snapshot and production state. Packet
files contain the question, approved truth/evidence, and one candidate answer,
but no system identity, question id, Token/latency data, retrieval trace, tool
trace, or round/phase metadata. Only first-round successful answers are judged;
repeat rounds remain performance-only.

Each reviewer returns a mode-`0600` JSON file shaped as follows. The strict
validator accepts exactly these 12 scoring fields and no commentary or extra
private data:

```json
{
  "schemaVersion": 1,
  "kind": "blind-answer-review-result",
  "graderId": "Reviewer-1",
  "manifestSha256": "<private manifest file SHA-256>",
  "packetSha256": "<packet file SHA-256>",
  "evaluations": [
    {
      "caseId": "Case-<opaque id>",
      "answerEvaluation": {
        "questionCorrect": true,
        "predictedFactCount": 1,
        "supportedFactCount": 1,
        "goldFactCount": 1,
        "matchedGoldFactCount": 1,
        "citationCount": 1,
        "validCitationCount": 1,
        "goldEvidenceCount": 1,
        "citedGoldEvidenceCount": 1,
        "hallucinatedFactCount": 0,
        "contradictionCount": 0,
        "refused": false
      }
    }
  ]
}
```

Generate a third, still identity-hidden packet only when the two reviews differ:

```bash
npm run benchmark:adjudicate -- arbitrate \
  --manifest /absolute/private/blind-review/blind-review.private-manifest.json \
  --grade /absolute/private/reviewer-1.result.json \
  --grade /absolute/private/reviewer-2.result.json \
  --output /absolute/private/arbitration.packet.json
```

The arbitration result uses `kind=blind-answer-arbitration-result`, the
arbitration packet SHA-256, and the same `caseId`/`answerEvaluation` entries.
Finally, `merge` writes the private `offline-results` accepted by
`benchmark-compare.mjs run`; agreed scores cannot be silently overridden, and a
disagreement cannot pass without a valid arbitration result.
