# Full 500-question frozen evaluation

User explicitly requested a background script using DSH to run the complete benchmark without waiting for Claude. Approved ongoing DeepSeek official API usage is unlimited for public and synthetic materials; existing cumulative accounting and api.lock remain in force.

- Dataset: pinned LongMemEval_S cleaned revision98d7416c24c778c2fee6e6f3006e7a073259d48f, all500, original order.
- Backend: frozen r4b snapshot, archive-only hybrid with offline e5-small; real plugin archive/search/read and system-prompt hooks. The runner uses the DSH model adapter and minimal isolated host fixtures, not the user's interactive session.
- Same pilot reader: DeepSeek Flash/high, free-text output, 16384 output tokens, recallBudgetChars16000, max12 tool rounds.
- Scoring: exact question-specific prompts extracted from pinned official get_anscheck_prompt, DeepSeek Flash/low judge,4096 output tokens to support reasoning. Original official default judge is GPT-4o2024-08-06, max10 output tokens. These model/output-limit adaptations remain disclosed.
- Every question remains in the500 denominator; report raw per-question accuracy, six original categories, seven diagnostic groups, all failures, actual usage and standard question_id/hypothesis JSONL.42 previously selected questions and458 fresh questions reported separately.
- This complete run is one pass, unmodified frozen backend. Subsequent fixes require a new named version and retained first-pass results.
- External public scores are reference configurations with differing models/judges. A full-suite result will replace the21-question pilot in the chart with configuration labels retained.


## Execution scheduling amendment

The first25 original-order questions are fully indexed. Their answer pass runs while the serial indexer continues preparing later histories. It uses exactly the same reader, backend, API phase, and append-only answer file. The main full500 runner resumes by skipping those recorded IDs, producing one answer per question overall. Selection is the original dataset prefix, before seeing its answers.
