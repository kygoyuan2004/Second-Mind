# Learning-review requests

Personal requests that recap learning or completed work over a period remain Q&A, but the server selects a deterministic review plan instead of relying on relevance top-K or file mtime. Detection is structural and covers multiple natural expressions; it is not an exact-string rule. A bare “所有”, “全部”, or “all” follow-up inherits the first request's captured `[start,end)` range.

The server-owned plan:

- leases one immutable index snapshot and enumerates its Markdown documents;
- extracts event dates from record filenames, headings, bodies, and intersecting weekly-plan sections; mtime may discover a changed file but is never activity evidence;
- prioritizes complete/paged diary, plan, weekly-plan, meeting, and activity records;
- follows verified paths, Wiki links, and bounded topic searches into supporting notes without allowing a note date to manufacture an activity;
- validates exact quotes and preserves completed, in-progress, planned, and uncertain statuses;
- reports candidate, complete, partial, failed, and budget-uncovered file counts.

The original review ceiling is retained: 50 scheduled model calls, 40 batched read/search operations, 30 minutes overall, and 24 minutes for retrieval expansion. WebSearch is disabled for this local review. Each scheduled extraction or grouping generation is executed once through Pi with `tools=[]` and `maxRetries=0`; Pi cannot choose the next read or start a multi-turn tool session. The legacy `PiAgentRuntime` explicitly rejects learning reviews.

## Runtime compatibility and failure reporting

The application model ID `qwen3.8-max[1M]` retains the original context selector. On the Bailian Anthropic transport only, the known `[1M]` selector is removed from the provider's wire model ID; the one-million-token application context declaration is unchanged. The provider settings form likewise edits the real wire ID. Custom provider identifiers are not rewritten.

The previous migration accidentally imposed a 180-second / 12,000-token extraction cap. Real xhigh extraction exceeded that cap. Extraction now uses the original 131,072-token output ceiling and a 600-second request ceiling, additionally capped by the configured provider timeout and the task's unchanged 30-minute deadline. This is not an increase in the number of model calls or tool operations.

The same original output ceiling applies to final grouping: an extra 4K limit could exhaust xhigh reasoning before valid grouping JSON. Extraction scheduling reserves the original last six minutes for finalization, not a full ten-minute provider request. Before minute 24, each call's timeout is clamped to the remaining retrieval time; at minute 24 no new extraction starts. Final grouping is clamped to the remaining 30-minute task deadline. Virtual-clock tests cover both boundaries, and a real TaskManager callback test checks effort and output limits in both stages.

Extraction may return compact references (`segmentId`, `lineStart`, `lineEnd`); the server restores the exact path and quote from the leased snapshot before applying the same evidence validator. A note date alone and a year inferred only from the question cannot independently establish an activity. These exclusions are processed locally and explicitly counted, leaving model calls for eligible activity records and supporting notes. Local exclusion is not reported as model reading.

Model-facing segment IDs are short batch-local aliases (`S1`, `S2`); internal snapshot IDs never need to be copied by the model. Canonical integer strings and a unique exact path/line reference can be restored without guessing source text. Out-of-bounds, ambiguous and conflicting references remain invalid. A wholly unparseable response receives at most one server-scheduled format retry, using the same batch and global budget; a model-authored non-verbatim quote is not retried to make it pass. Diagnostics contain only counts of missing fields, unresolved references, absent/non-verbatim quotes and invalid date formats, never private model prose.

Supporting notes are paged breadth-first: one page from each anchored note precedes second pages. A long course note cannot spend the entire call/time budget before other learning directions are read. Whole-note completion is claimed only if every planned segment was actually processed; otherwise the note remains partial or uncovered.

Read slots are also shared round-robin across topic searches while retaining each search's result ranking and prioritizing direct links. Out-of-period diaries and plans are not repackaged as reference knowledge. Generation input includes explicit absolute line numbers alongside the unchanged canonical text, so evidence selection does not depend on the model manually counting a long document's lines.

Before semantic expansion, names from every verified activity are matched against the fixed inventory's filenames, paths, and first Markdown headings. A generic rarity-weighted lexical match gives each event its best named note; repeated events do not take the next unused hit and crowd out older subjects. Direct paths still take priority. This uses inventory metadata already scanned, adds no model call, and each selected note still consumes the shared read budget. It contains no course-specific names or question-string cases.

For supplementary generation the compact contract is `statement` plus `noteEvidence`. The server supplies the already-validated parent event and its primary evidence; Pi need not copy opaque parent IDs, dates, or status fields. A supplied conflicting parent or forged note reference is still rejected. This prevents clerical model-output mistakes from discarding otherwise grounded explanations without weakening source verification.

An unchecked whole-task checkbox does not erase an explicit actual-work receipt such as “今日完成1小时，剩余顺延”: it remains in progress, not completed. Future targets such as “计划今日完成1小时” remain plans. Explicit learning-and-documenting receipts can establish completed learning.

Checked tasks from successfully processed activity lines are retained as independent completion receipts if the model omitted them or merged them into older plans. They do not promote neighboring unchecked tasks and cost no extra model call. A reference such as “承接某日计划” is not the current activity date; dates are calculated and displayed per evidence source. Knowledge explanations appear once in the supporting-material section, with links beside their parent events, rather than being duplicated in both sections.

Unchecked items omitted from a successfully processed record that already contains verified relevant facts are likewise retained verbatim as plans. This does not import every task from otherwise unrelated records. A “currently completed” diary summary is labelled as a status snapshot as of its record date, not proof that all listed work was completed within the review period. Carryover references such as yesterday's remainder being moved into today do not rewrite today's activity date; an explicitly dated yesterday completion still retains that earlier date.

Weekly-plan fragments without a source-supported year remain temporally uncertain. Their opening excerpts are shown in the uncertain-material section with original month/day notation, rather than only reporting their count or silently assigning the request's year. These locally inspected excerpts are not claimed as model-extracted activities or in-period achievements.

Filesystem failures and model-processing failures are reported separately. Invalid model bindings and authentication fail immediately; failure of every attempted activity batch fails the task instead of publishing an empty successful review. A successful but partial extraction reports its coverage gaps. Mock tests cannot establish natural-language answer quality: deployment acceptance must also ask the real services the same question and compare primary evidence, statuses, supporting notes, and budgets.
