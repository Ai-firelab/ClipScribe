# ClipScribe - Instagram Reel Downloader and Gemini Transcriber

[![Apify Ready](https://img.shields.io/badge/Apify-Ready-blue)](https://apify.com)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)

ClipScribe is a production-grade Apify Actor that downloads public Instagram Reels and generates accurate transcripts using Google Gemini's multimodal capabilities. The output is structured as JSON, making it ideal for content research, search engine optimization (SEO), database storage, or analytics workflows.

Reels are fetched primarily through Apify's maintained [Instagram Scraper](https://apify.com/apify/instagram-scraper) — it handles proxies, authentication, and extractor upkeep, returning a direct video URL plus metrics. A self-updating `yt-dlp` path is kept as an automatic fallback.

## Features

- **Instagram Reel Downloading**: Primary path via the Apify Instagram Scraper actor (proxy/auth handled for you), with an automatic self-updating `yt-dlp` fallback.
- **Performance Metrics**: Returns views, likes, comments, followers, engagement rate, and a relative **outlier score** alongside the transcript.
- **AI Transcription**: Powered by Google Gemini (default: `gemini-2.5-flash`).
- **Multimodal Analysis**: Directly uploads the downloaded video to the Gemini File API for transcription.
- **Language Detection & Hints**: Support for explicit language hints to improve transcription accuracy.
- **Structured Output**: Returns standardized JSON containing the original video metadata, Gemini file reference, and transcription text.
- **Retry Mechanism**: Resilient download and execution logic with exponential backoff retries.
- **Temporary Resource Cleanup**: Automatic deletion of temporary files and Gemini files after successful completion.
- **Secure Key Management**: Support for passing the Gemini API key securely via environment variables or actor input parameters.

## Prerequisites

- Node.js >= 20
- Apify CLI (for local testing and deployment)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd ClipScribe
   ```
2. Install the dependencies:
   ```bash
   npm install
   ```

## Configuration

Create a `.env` file in the root directory for local execution:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Alternatively, you can provide the `apiKey` parameter directly in the Actor input.

## Usage

### Local Development

Run the actor locally using the Apify CLI or Node:

```bash
npm start
```

For customized local datasets or specific URL overrides, run:

```bash
node src/main.js --datasetId=example-dataset --startUrls='[{"url":"<INSTAGRAM_REEL_URL>"}]'
```

### Actor Input Schema

The actor accepts the following input parameters:

```json
{
  "reelUrl": "<INSTAGRAM_REEL_URL>",
  "model": "gemini-2.5-flash",
  "languageHint": "auto",
  "keepLocalVideo": false,
  "maxRetries": 3,
  "apiKey": "optional_api_key"
}
```

### Example Input

```json
{
  "reelUrl": "https://www.instagram.com/reel/C9FvJ4WPM_O/",
  "model": "gemini-2.5-flash",
  "languageHint": "en",
  "keepLocalVideo": false
}
```

## Deployment

Deploy the actor to your Apify console:

1. Authenticate with the Apify CLI:
   ```bash
   apify login
   ```
2. Deploy to the cloud:
   ```bash
   apify push
   ```

## Output Format

Once execution completes, the actor saves the structured record to the default dataset:

```json
{
  "sourceUrl": "<INSTAGRAM_REEL_URL>",
  "model": "gemini-2.5-flash",
  "languageHint": "en",
  "outlierScore": 4.2,
  "views": 184523,
  "likes": 12045,
  "comments": 321,
  "followers": 250000,
  "engagement": 6.7,
  "metrics": {
    "outlierScore": 4.2,
    "views": 184523,
    "likes": 12045,
    "comments": 321,
    "followers": 250000,
    "engagement": 6.7,
    "engagementRate": 6.7,
    "engagementRateByFollowers": 4.95,
    "interactions": 12366,
    "uploader": "Example Creator",
    "username": "examplecreator",
    "outlierBaseline": {
      "medianViews": 43800,
      "sampleSize": 11,
      "note": null
    }
  },
  "localVideo": {
    "path": "/tmp/reel-12345/video.mp4",
    "bytes": 1234567
  },
  "geminiFile": {
    "name": "files/example-file-id",
    "uri": "https://generativelanguage.googleapis.com/v1beta/files/example-file-id",
    "mimeType": "video/mp4",
    "state": "ACTIVE"
  },
  "transcript": "Transcribed text contents of the video.",
  "createdAt": "2026-06-11T20:44:55.000Z"
}
```

### Metrics fields

| Field | Meaning |
|---|---|
| `views`, `likes`, `comments`, `followers` | Mapped from the Instagram Scraper item (`videoPlayCount`, `likesCount`, `commentsCount`). `followers` is usually `null` on the primary path — the per-post scrape doesn't carry the account follower count. On the yt-dlp fallback, views/followers need authentication (see **Cookies**). |
| `engagement` / `engagementRate` | `(likes + comments) / views * 100` — how compelling the reel was to the people who watched it. |
| `engagementRateByFollowers` | `(likes + comments) / followers * 100` — the classic account-level Instagram engagement metric. |
| `outlierScore` | `this reel's views / the account's median reel views`. `1` ≈ an average reel for the account; `5` means it got ~5x the account's typical views. Requires an **online lookup** of the account's recent reels (see below). |
| `metrics.outlierBaseline` | The median views and sample size used for the outlier score, plus a `note` explaining why the score is `null` when it could not be computed. |

> **Outlier score is best-effort.** Computing it requires fetching a sample of the
> account's recent reels online to establish a baseline. Instagram rate-limits and
> often gates unauthenticated profile listings, so the score may come back `null`
> with a reason in `metrics.outlierBaseline.note`. A residential proxy and account
> cookies significantly improve reliability. Disable the lookup entirely with
> `"computeOutlierScore": false`.

## Cookies (yt-dlp fallback only)

The primary Apify Instagram Scraper path needs no cookies — it manages its own auth. Cookies only matter when the actor falls back to `yt-dlp`. As of 2026, Instagram has largely closed off logged-out access, so for the fallback path:

- **Downloading at all.** Many reels return an *"Instagram sent an empty media response… use --cookies"* error for logged-out requests. A valid `sessionid` cookie is increasingly required just to fetch the video. The actor detects this error class and tells you when cookies are needed.
- **Metadata.** `view_count` and `channel_follower_count` are only exposed to authenticated requests; without cookies they come back `null` (though `like_count` / `comment_count` are usually visible).

> **Pair cookies with a residential proxy.** Datacenter IPs are blocked quickly. The default
> `proxyConfiguration` already requests the Apify `RESIDENTIAL` group.

To authenticate:

1. **Extract your Instagram session cookies.** In your browser:
   - Open [instagram.com](https://instagram.com) and log in to your account.
   - Open DevTools (F12 / right-click → Inspect).
   - Go to **Application** → **Cookies** → `instagram.com`.
   - Export the cookies. Easiest is a browser extension like **Cookie-Editor** or **EditThisCookie** → "Export as JSON"; the actor accepts that full shape (including `expirationDate`, `domain`, `path`). A minimal `[{"name":"sessionid","value":"..."}]` list also works.

2. **Pass to the actor:**
   - In Apify Console, paste the JSON into the `instagramCookiesJson` input field.
   - Or in your code: `"instagramCookiesJson": "[{\"name\":\"sessionid\",\"value\":\"...\"}]"`

3. **Session rotation:** Instagram invalidates sessions over time. If downloads start failing or `view_count` goes `null` again, re-export fresh cookies while logged in.

## Keeping yt-dlp current

The actor downloads Instagram via the `yt-dlp` binary. Instagram's extractor breaks every few weeks and yt-dlp ships fixes constantly, so a binary frozen into the Docker image goes stale. Two mechanisms keep it fresh:

- **Runtime self-update (default).** Before each download the actor self-updates the binary (`yt-dlp -U`), best-effort with a 90s timeout — a failed update never blocks the run. Control it with the `ytdlpUpdateChannel` input: `stable` (default), `nightly`/`master` (bleeding-edge extractor fixes, useful right after Instagram breaks), or `none` to use the baked-in binary. The resolved version is logged each run.
- **Build-time.** The image ships the self-contained `yt-dlp_linux` build (no system Python, and it supports self-update). Rebuild — or bump the `CACHEBUST` build arg — to pull a fresh binary at build time too.

**Security note:** Never commit cookies to version control. Use Apify secrets or environment variables.

## License

ISC

## Contributing

Contributions are welcome. Please open an issue or submit a pull request for improvements.

## Support

For issues, questions, or bug reports, please submit an issue on the repository page.

---

**Developed for the Apify Community**
