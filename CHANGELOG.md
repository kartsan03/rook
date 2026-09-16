# Changelog

## Unreleased

### Fixed

- Briefs are bound to their input via a SHA-256 fingerprint; stale/legacy Briefs are rejected by the dossier step. Empty LLM output fails before publishing an artifact.
- Ghosting counts the union of hearts and matched replies per audience comment, excludes creator messages and duplicate IDs, and reports empty samples as unknown. Fusion pools rates by sampled comment counts.
- Grounded quotes receive source-date annotations; inline ISO/English month-first date labels and adjacent ISO-date labels no longer override the source. Invalid or ambiguous source dates become `date_unknown`.
- Dollar validation treats magnitude suffixes as part of the amount: an allowed `$100` no longer permits `$100 million` or `$100M`.
- No-signal analysis exits 2; batch distinguishes SKIPPED from SUCCESS and exits nonzero on skips or failures.
- Instagram uses measured `videoPlayCount` only, preserving measured zero versus unknown. Likes-based and legacy unlabelled proxy views are excluded from core/fusion; missing measured reach produces unavailable revenue. Instagram/combined bot probability is unknown rather than a fabricated low-risk score. Offline regressions cover these paths.
- Fusion dead-audience penalty now cuts the **weaker** platform's core. It used to cut the stronger side (the opposite of the documented rule), deflating fused core and revenue estimates for every imbalanced creator (~6.5x in the audit example). Pure logic moved to `applyFusionPenalty` in `src/metrics.js` with unit tests (`test/fusion.test.js`); fusion_data.js keeps the same CLI behavior.
- `ingest_youtube.js` exits with an error and leaves existing `data/raw_*.json` / `data/latest_creator_data.json` untouched when every video fetch fails. Before, a fully failed run still wrote `videos: []` over both files with exit 0.
- `ingest_youtube.js` retries channel sizing on a later video if the first attempt failed. Previously one failed sizing call froze `subscribers: 0` and `creator_id: ''` for the whole run, breaking the bot gate and creator-reply detection.
- `isGrounded` is one-direction only (`allowText.includes(quote)`); padded hallucinations no longer pass via reverse/prefix hatch.
- COMPUTED METRICS block is spliced into saved Brief/Dossier markdown after quote grounding (not prompt-only).
- Unexpected `$` amounts outside code-owned §4 / metrics are scrubbed from saved markdown.
- README Troubleshooting: fail-loud mid-run fallback; document `ROOK_ALLOW_LLM_FALLBACK=1`.
- Missing YouTube `published_at` is `null` / `date_unknown`, not scrape-time now.

### Added


- Quote allow-list + post-validation gate: LLM quotes must be substrings of filtered comments (`comment_filter.js`).
- Code-owned COMPUTED METRICS block and §4 financial transparency line (`core × CR × price × mult = $`); mock benchmarks labeled illustrative.
- Fixture replay tests (`test/fixtures/raw_fixture_anon.json`) asserting §4 dollars, core/geo/SNR, and quote gate without live scrape/API keys.
- `temperature: 0` on Gemini and OpenAI; per-pass provider/model footer on briefs/dossiers.

### Changed

- Mid-run Gemini→OpenAI fallback is fail-loud (banner + throw) unless `ROOK_ALLOW_LLM_FALLBACK=1`. Straight OpenAI when no Gemini key is unchanged.
- Missing comment timestamps are `null` / `date_unknown` (YouTube and Instagram ingest); scrape-time `new Date()` is never used as a comment date.

## 1.1.0 - 2026-09-02
### Changed

- Default Gemini model is now `gemini-3.6-flash`: the previous default `gemini-2.0-flash` was shut down by Google. Override with `GEMINI_MODEL`; `gemini-3.5-flash-lite` is the cheapest current-generation option.
- OpenAI fallback moved from `gpt-4o-mini` to `gpt-5-mini`, overridable with the new `OPENAI_MODEL`.
- Reels transcription moved off the deprecated `whisper-1` to `gpt-transcribe` (OpenAI removes `whisper-1` from the API on 2027-02-26).

### Fixed

- `ingest_youtube.js` resolves a single-video URL to its channel directly. Before, only the batch runner did; a direct run produced a broken listing request and a raw filename containing `?`.
- `process_brief.js` / `process_logic.js` no longer print `NaN%` for raw data without precomputed rates, and fail with a clear message on files that are not creator data.
- `npm audit fix` patched 5 high-severity vulnerabilities in transitive dependencies.

### Added

- Node 20 + 22 CI matrix. CONTRIBUTING, code of conduct, issue/PR templates.

## 1.0.0 - 2026-07-04

- Initial release.
