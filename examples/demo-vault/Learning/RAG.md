# Retrieval-Augmented Generation

Retrieval-Augmented Generation (RAG) grounds a language model in documents selected at query time.

## Hybrid retrieval

Lexical retrieval is strong for exact identifiers, dates, and names. Dense vector retrieval helps when the query and note use different wording. Reciprocal Rank Fusion (RRF) combines the two ranked lists without requiring their scores to share a scale.

## Grounding

The generator should receive bounded excerpts with source paths. Answers must cite those paths, and should explicitly say when the retrieved evidence is insufficient.

## Evaluation

Useful offline metrics include Recall@K, mean reciprocal rank, and nDCG. A curated dataset should be versioned with a hash of the source corpus so results cannot silently drift.
