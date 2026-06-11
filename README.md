# ClipScribe - Instagram Reel Downloader and Gemini Transcriber

[![Apify Ready](https://img.shields.io/badge/Apify-Ready-blue)](https://apify.com)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green)](https://nodejs.org/)

ClipScribe is a production-grade Apify Actor designed to download public Instagram Reels using `youtube-dl-exec` and generate accurate transcripts using Google Gemini's multimodal capabilities. The output is structured as JSON, making it ideal for content research, search engine optimization (SEO), database storage, or analytics workflows.

## Features

- **Instagram Reel Downloading**: Robust video retrieval using a built-in `youtube-dl-exec` wrapper.
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

## License

ISC

## Contributing

Contributions are welcome. Please open an issue or submit a pull request for improvements.

## Support

For issues, questions, or bug reports, please submit an issue on the repository page.

---

**Developed for the Apify Community**
