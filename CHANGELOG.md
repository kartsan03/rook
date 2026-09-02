# Changelog

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
