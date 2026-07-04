# rook

[![CI](https://github.com/kartsan03/rook/actions/workflows/ci.yml/badge.svg)](https://github.com/kartsan03/rook/actions/workflows/ci.yml)

Rook builds a sales dossier on a content creator from their public footprint. It scrapes a creator's recent YouTube videos and/or Instagram posts (metadata, comments, transcripts), computes engagement metrics in plain code, and uses an LLM to turn the material into two documents: an audience analysis ("The Brief") and a "Master Sales Dossier" with a product offer, direct audience quotes, a revenue estimate, and a ready-to-send outreach message.

It exists for teams that sell to creators: agencies, course platforms, community tools, creator-economy startups. Before you pitch a creator, you want to know whether their audience is alive, what those viewers are asking for, what product would fit, and what number belongs in the cold DM. Rook answers that in one run per creator, for a few cents of API cost.

One deliberate design choice: the LLM never computes money. Revenue estimates are calculated in `process_logic.js` from scraped view counts and a benchmark table, then inserted into the finished document. The model only writes prose around numbers it cannot change.

## How it works

The pipeline is five small scripts run in sequence, plus a batch runner. No framework, no database; state is JSON files in `data/` and Markdown in `audits/`.

1. `src/ingest_youtube.js` pulls a channel's last 10 videos with `yt-dlp`: views, likes, and up to 200 comments per video (sample size scales with channel size), plus transcripts via `youtube-transcript`. It computes the ghosting rate (share of comments the creator never hearted or replied to) and a bot probability from the view-to-subscriber ratio.
2. `src/ingest_instagram_apify.js` pulls a profile and its latest posts through two Apify actors (`instagram-profile-scraper`, `instagram-comment-scraper`). If `OPENAI_API_KEY` is set, Reels audio is transcribed with Whisper.
3. `src/fusion_data.js` (optional) merges the YouTube and Instagram data for one creator into a single profile. It computes a "core audience" per platform (roughly the 10th percentile of views, the floor the creator reaches without algorithmic luck) and cuts the weaker platform's core when the reach gap between platforms exceeds 20x.
4. `src/process_brief.js` filters out noise comments (emoji-only, very short, thank-yous in several languages, duplicates), then asks Gemini for The Brief: pain freshness, promo fatigue, commercial intent, ghosting, geo tier, creator archetype, top pain points.
5. `src/process_logic.js` runs the deterministic revenue math (core audience x niche conversion rate x geo-adjusted ticket price, with penalties for low comment signal and likely bot audiences), then three LLM passes (strategist draft, critic, refiner) to produce the final dossier.

`src/batch_analyze.js` runs the whole sequence over a targets file and prints a success/failure summary.

Gemini is the primary model (`gemini-2.0-flash` by default, override with `GEMINI_MODEL`). On rate limits the pipeline waits and retries; when the Gemini quota is exhausted it falls back to OpenAI `gpt-4o-mini` if a key is present.

## Requirements

- Node.js 18 or newer
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your PATH (used for YouTube and for extracting Reels audio)
- A Google Gemini API key (the free tier works; the pipeline waits out its rate limits)
- Optional: an OpenAI API key (Gemini fallback and Whisper transcription of Reels)
- Optional: an Apify token with credits, only for Instagram ingestion

## Installation

```bash
git clone <this repo>
cd rook
npm install
cp .env.example .env   # then fill in your keys
```

`.env` variables:

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes* | Primary analysis model |
| `GEMINI_MODEL` | no | Model override, defaults to `gemini-2.0-flash` |
| `OPENAI_API_KEY` | no* | Fallback model and Whisper for Reels |
| `APIFY_TOKEN` | Instagram only | Runs the two Instagram scraper actors |

*At least one of `GEMINI_API_KEY` / `OPENAI_API_KEY` must be set; without a Gemini key every call goes straight to OpenAI.

## Running it

Analyze one YouTube channel:

```bash
node src/ingest_youtube.js "https://www.youtube.com/@SomeChannel" --niche "Fitness & Health"
node src/process_brief.js
node src/process_logic.js
```

Analyze one Instagram profile:

```bash
node src/ingest_instagram_apify.js "some_username" --niche "Lifestyle & Vlogs"
node src/process_brief.js
node src/process_logic.js
```

Cross-platform (fusion) analysis of one creator:

```bash
node src/ingest_youtube.js "https://www.youtube.com/@SomeChannel"
node src/ingest_instagram_apify.js "some_username"
node src/fusion_data.js "SomeChannel" "some_username"
node src/process_brief.js
node src/process_logic.js
```

Batch over a list (see `targets.example.txt` for the format; YouTube URLs, `ig:username`, or `yt | ig` fusion pairs):

```bash
node src/batch_analyze.js targets.txt --niche "Software Engineering & Backend"
```

The `--niche` value selects a row in `config/mock_benchmarks.json` (conversion rates and ticket price). An unknown niche falls back to the `Unknown` row. Edit that file to match your own market data; the shipped numbers are rough placeholder estimates.

## Output

- `data/raw_<handle>.json`, `data/raw_ig_<username>.json`, `data/fused_<yt>_<ig>.json`: scraped data per creator
- `data/latest_creator_data.json`: the most recently ingested profile (default input for the analysis scripts)
- `audits/the_brief_<handle>.md`: the audience analysis
- `audits/investment_brief_<handle>_<timestamp>.md`: the final dossier, including the financial model and the outreach text
- `audits/debug_<run>_draft.md`, `audits/debug_<run>_critique.md`: intermediate LLM passes, kept for inspection

`examples/` contains a full brief and dossier for a fictional creator, so you can see the output format without running anything.

## Checking your setup

```bash
npm test          # unit tests for the metrics and filtering logic
yt-dlp --version
```

Then run the three YouTube commands above against any small channel. A complete run takes a few minutes (comment scraping is the slow part) and should end with a dossier path printed to the console.

## Project structure

```
src/
  ingest_youtube.js         YouTube scraping and engagement metrics
  ingest_instagram_apify.js Instagram scraping via Apify, Whisper transcription
  fusion_data.js            YT+IG merge with core-audience math
  process_brief.js          comment filtering + The Brief (LLM)
  process_logic.js          revenue math (code) + dossier (LLM triad)
  batch_analyze.js          runs the pipeline over a targets file
  llm.js                    Gemini calls, retry/backoff, OpenAI fallback
  comment_filter.js         shared comment noise filter
  metrics.js                core-audience, geo and revenue math (pure functions)
test/                       unit tests for the pure logic (node --test)
examples/                   sample brief and dossier for a fictional creator
config/mock_benchmarks.json niche conversion rates and ticket prices
data/                       scraped JSON (gitignored)
audits/                     generated briefs and dossiers (gitignored)
```

## Limitations

- The benchmark table is illustrative, not market research. Revenue estimates are only as good as the numbers you put in `config/mock_benchmarks.json`.
- YouTube scraping depends on `yt-dlp` and breaks when YouTube changes; keep `yt-dlp` updated.
- Instagram photo posts have no view count, so reach is approximated as likes x 10.
- Geo detection only distinguishes Cyrillic and Devanagari script shares; a Spanish- or Portuguese-speaking audience is priced as Tier 1/2.
- The ghosting rate only sees the comments that were fetched, not the full comment history.
- The dossier text is LLM output. The numbers in the financial block are computed, everything else is generated. Read it before you send it to anyone.

## Privacy and responsible use

This tool collects public data about real people and generates documents about them.

- `data/`, `audits/`, `targets.txt`, and `.env` are gitignored. Keep it that way: scraped comments and generated dossiers are personal data and do not belong in a repository.
- Depending on your jurisdiction (GDPR in particular), storing and processing this data may create legal obligations for you. That is your responsibility, not the tool's.
- Scraping may violate the terms of service of YouTube, Instagram, or Apify's actor policies depending on how you use it. Review them before running this at scale.
- Use the output for legitimate business outreach. Do not use it to harass, dox, or deceive anyone.

## Troubleshooting

- `yt-dlp: command not found` (or not recognized): install yt-dlp and make sure it is on the PATH of the shell running Node.
- Long pauses with `Rate limit hit, waiting Ns`: normal on the Gemini free tier. The pipeline resumes on its own; set `OPENAI_API_KEY` if you want the fallback instead of the wait.
- `Gemini daily quota exhausted`: the free daily budget is gone. Wait for the reset or rely on the OpenAI fallback.
- Apify errors mentioning credits or billing: your Apify account is out of credits. YouTube-only targets still work.
- `Health check failed: ... no comments with signal`: the creator's comments were all noise (emoji, one-word thanks). No dossier is produced for them; that is the intended behavior.
- Empty or tiny comment sets on YouTube: some channels disable comments or get very few; the brief will be thin.
