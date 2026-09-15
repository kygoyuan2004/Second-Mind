# Learning reviews

Ask for a personal learning review with an explicit date range, for example: “回顾 2026 年 9 月 14 日至 2026 年 9 月 15 日的全部学习，区分完成、进行中和计划。”

`src/original/learning-review.mjs` resolves the range once using the configured timezone and first-turn timestamp. A future endpoint is clipped to the current anchor. Follow-ups such as “所有” inherit that scope. The prompt and tool hooks come from the original application.

The agent first enumerates dated records with Glob/Grep, then reads the inventory. Semantic top-K candidates do not define coverage. Learning events require dated evidence; file modification time alone does not establish when learning occurred. Plans and unchecked tasks are not completed achievements.

The original budget is 50 turns, 30 minutes, at most 40 read/search calls and 24 minutes for expanding the reading scope. The remaining time supports synthesis. Normal mode does not create subagents. Deep mode allows at most two under the original topic/coverage conditions. Networking is skipped for personal reviews.

A useful result names the fixed range, distinguishes completion states, cites evidence, and reports candidate, complete, partial, failed and unprocessed counts. Model adherence is not guaranteed: inspect the evidence and coverage statements. The isolated real Qwen review passed date and state checks but used prose/backtick source labels in parts of the answer instead of consistently following the requested citation notation; this is recorded in the migration report.
