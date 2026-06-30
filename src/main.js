import { Actor, log } from 'apify';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { lookup as lookupMime } from 'mime-types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ytdlp from 'youtube-dl-exec';

const execFileAsync = promisify(execFile);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);
// Partial / intermediate artifacts yt-dlp may leave behind mid-download.
const PARTIAL_SUFFIXES = ['.part', '.ytdl', '.tmp', '.temp'];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyInstagramReelUrl(url) {
    try {
        const u = new URL(url);
        return /(^|\.)instagram\.com$/i.test(u.hostname) && /\/reel\//i.test(u.pathname);
    } catch {
        return false;
    }
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}


function toFiniteNumber(value) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}


function median(numbers) {
    const sorted = numbers.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}


function round(value, digits = 4) {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}


function deriveUsername(info) {
    if (!info) return null;
    if (info.uploader_url) {
        try {
            const segment = new URL(info.uploader_url).pathname.split('/').filter(Boolean)[0];
            if (segment) return segment;
        } catch {
            // ignore malformed URL and fall through
        }
    }
    return info.uploader_id || info.channel || info.uploader || null;
}

function extractStats(info) {
    if (!info) {
        return { views: null, likes: null, comments: null, followers: null, uploader: null, username: null };
    }
    return {
        views: toFiniteNumber(info.view_count),
        likes: toFiniteNumber(info.like_count),
        comments: toFiniteNumber(info.comment_count),
        followers: toFiniteNumber(info.channel_follower_count),
        uploader: info.uploader ?? info.channel ?? null,
        username: deriveUsername(info),
    };
}


function computeEngagement({ likes, comments, views, followers }) {
    const hasInteraction = likes !== null || comments !== null;
    const interactions = hasInteraction ? (likes ?? 0) + (comments ?? 0) : null;
    return {
        interactions,
        engagementRate: hasInteraction && views ? round((interactions / views) * 100) : null,
        engagementRateByFollowers: hasInteraction && followers ? round((interactions / followers) * 100) : null,
    };
}

async function readReelInfoJson(dir) {
    try {
        const items = await fs.readdir(dir);
        const infoFile = items.find((name) => name.toLowerCase().endsWith('.info.json'));
        if (!infoFile) return null;
        const raw = await fs.readFile(path.join(dir, infoFile), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function fetchAccountViewCounts({ username, proxyUrl, sampleSize, timeoutMs, excludeId }) {
    const profileUrl = `https://www.instagram.com/${username}/reels/`;
    const options = {
        dumpSingleJson: true,
        playlistEnd: sampleSize,
        ignoreErrors: true,
        socketTimeout: 30,
        quiet: true,
        noWarnings: true,
    };
    if (proxyUrl) options.proxy = proxyUrl;

    const result = await ytdlp(profileUrl, options, { timeout: timeoutMs });
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    const entries = Array.isArray(data?.entries) ? data.entries : data ? [data] : [];

    const views = [];
    for (const entry of entries) {
        if (!entry || (excludeId && entry.id === excludeId)) continue;
        const v = toFiniteNumber(entry.view_count);
        if (v !== null) views.push(v);
    }
    return views;
}

async function computeOutlierScore({ views, username, proxyUrl, sampleSize, timeoutMs, currentId }) {
    if (views === null) {
        return { score: null, baseline: null, sampleSize: 0, reason: 'This reel exposes no view_count to score against.' };
    }
    if (!username) {
        return { score: null, baseline: null, sampleSize: 0, reason: 'Could not determine the account handle for a baseline.' };
    }
    try {
        const sample = await fetchAccountViewCounts({ username, proxyUrl, sampleSize, timeoutMs, excludeId: currentId });
        const baseline = median(sample);
        if (!baseline) {
            return {
                score: null,
                baseline: null,
                sampleSize: sample.length,
                reason: 'Instagram returned no comparable reels with view counts (often login/rate-limit gated).',
            };
        }
        return {
            score: round(views / baseline, 2),
            baseline,
            sampleSize: sample.length,
            reason: null,
        };
    } catch (err) {
        return {
            score: null,
            baseline: null,
            sampleSize: 0,
            reason: `Baseline lookup failed: ${err?.message || err}`,
        };
    }
}


async function findNewestVideoFile(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const files = [];

    for (const item of items) {
        if (!item.isFile()) continue;
        const name = item.name.toLowerCase();
        if (PARTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
        if (!VIDEO_EXTENSIONS.has(path.extname(name))) continue;

        const full = path.join(dir, item.name);
        const stat = await fs.stat(full);
        files.push({ full, mtimeMs: stat.mtimeMs });
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.full ?? null;
}

function isRetryableGeminiError(err) {
    const status = err?.status ?? err?.code ?? err?.response?.status;
    if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
        return true;
    }
    const message = String(err?.message || '').toUpperCase();
    return (
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('UNAVAILABLE') ||
        message.includes('RATE LIMIT') ||
        message.includes('429') ||
        message.includes('503')
    );
}


async function withGeminiRetry(label, fn, { maxRetries = 4 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt === maxRetries || !isRetryableGeminiError(err)) {
                throw err;
            }
            const delayMs = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(attempt * 250);
            log.warning(
                `Gemini call "${label}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms: ${err?.message || err}`,
            );
            await sleep(delayMs);
        }
    }
    throw lastError;
}

// Normalise the requested self-update channel. `stable` tracks the latest tagged
// release; `nightly`/`master` track bleeding-edge extractor fixes (useful when a
// site like Instagram just broke and the fix hasn't been tagged yet); `none`
// skips the update entirely.
function getYtDlpUpdateChannel(requested) {
    const raw = String(requested || process.env.YTDLP_UPDATE_CHANNEL || 'stable').toLowerCase();
    return ['stable', 'nightly', 'master', 'none'].includes(raw) ? raw : 'stable';
}

// Refresh the yt-dlp binary to the newest build at startup. The binary baked into
// the Docker image at build time goes stale quickly (Instagram's extractor breaks
// every few weeks and yt-dlp ships fixes constantly), so we pull the latest at
// runtime. Best-effort by design: a slow or failed update must never block a run —
// we just fall back to whatever binary is already on disk. Requires the
// self-contained build (yt-dlp_linux / yt-dlp.exe); the python zipapp can't self-update.
async function refreshYtDlpBinary(channel, timeoutMs = 90_000) {
    if (channel === 'none') return;
    const binPath = ytdlp?.constants?.YOUTUBE_DL_PATH;
    if (!binPath) {
        log.warning('Could not resolve the yt-dlp binary path; skipping self-update.');
        return;
    }
    const updateArgs = channel === 'stable' ? ['-U'] : ['--update-to', channel];
    try {
        await execFileAsync(binPath, updateArgs, { timeout: timeoutMs });
        log.info(`yt-dlp self-update (${channel}) completed.`);
    } catch (err) {
        // `-U` exits non-zero when already up to date or when self-update is
        // unsupported for this build — neither is fatal for the actual download.
        log.warning(
            `yt-dlp self-update (${channel}) did not complete cleanly: ${err?.stderr || err?.shortMessage || err?.message}. `
            + 'Continuing with the installed binary.',
        );
    }
    // Always record the resolved version so failed runs are debuggable.
    try {
        const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 15_000 });
        log.info(`yt-dlp version in use: ${String(stdout).trim()}`);
    } catch {
        // Version probe is purely informational; ignore failures.
    }
}

// Convert a JSON cookie array (Instagram, exported from a browser extension such as
// "Cookie-Editor" / "EditThisCookie", or a minimal [{name,value}] list) into the
// Netscape cookie format yt-dlp reads. Returns whether an auth `sessionid` was seen.
function buildNetscapeCookies(cookies) {
    // ~2033. A far-future stamp marks cookies as persistent; the previous code used
    // `0`, which yt-dlp interprets as a session cookie and effectively discards —
    // silently nullifying authentication.
    const FAR_FUTURE = 2_000_000_000;
    const lines = [
        '# Netscape HTTP Cookie File',
        '# Generated by the ClipScribe actor.',
    ];
    let hasSession = false;
    for (const cookie of cookies) {
        const { name, value } = cookie;
        if (!name || value === undefined || value === null) continue;
        if (name === 'sessionid') hasSession = true;
        const domain = cookie.domain || '.instagram.com';
        const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const cookiePath = cookie.path || '/';
        const secure = cookie.secure === false ? 'FALSE' : 'TRUE';
        // Browser exports use `expirationDate` (float seconds); accept common aliases
        // and fall back to a far-future stamp so the cookie is treated as persistent.
        const expiryRaw = cookie.expirationDate ?? cookie.expires ?? cookie.expiry;
        const expiryNum = Number(expiryRaw);
        const expiry = Number.isFinite(expiryNum) && expiryNum > 0 ? Math.floor(expiryNum) : FAR_FUTURE;
        lines.push([domain, includeSub, cookiePath, secure, expiry, name, value].join('\t'));
    }
    return { content: lines.join('\n') + '\n', hasSession };
}

// True when yt-dlp's failure is the Instagram "needs authentication / throttled"
// class, so we can surface an actionable message instead of a raw stack trace.
function isInstagramAuthError(err) {
    const m = String(err?.stderr || err?.message || err).toLowerCase();
    return (
        m.includes('empty media response')
        || m.includes('login required')
        || m.includes('rate-limit reached')
        || m.includes('requested content is not available')
        || m.includes('use --cookies')
    );
}

async function downloadReel({ url, outputDir, maxRetries = 3, proxyUrl, instagramCookiesJson, timeoutMs = 5 * 60 * 1000 }) {
    await ensureDir(outputDir);

    const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');
    let lastError;

    // Parse and write cookies to a temp file if provided. Instagram gates view_count
    // and channel_follower_count behind authentication.
    let cookiesFile;
    if (instagramCookiesJson) {
        try {
            const cookies = JSON.parse(instagramCookiesJson);
            if (!Array.isArray(cookies)) {
                throw new Error('Expected a JSON array of cookie objects.');
            }
            const { content, hasSession } = buildNetscapeCookies(cookies);
            cookiesFile = path.join(outputDir, 'cookies.txt');
            await fs.writeFile(cookiesFile, content, 'utf8');
            if (hasSession) {
                log.info('Using Instagram cookies (sessionid present) for authenticated extraction.');
            } else {
                log.warning(
                    'Instagram cookies were supplied but contain no "sessionid" — Instagram likely '
                    + 'still treats requests as logged-out. Re-export cookies while logged in.',
                );
            }
        } catch (err) {
            log.warning(`Failed to parse instagramCookiesJson: ${err.message}. Continuing without cookies.`);
            cookiesFile = null;
        }
    }

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const options = {
                output: outputTemplate,
                noPlaylist: true,
                mergeOutputFormat: 'mp4',
                format: 'bv*+ba/b',
                retries: 2,
                socketTimeout: 30,
                quiet: true,
                noWarnings: true,
                writeInfoJson: true,
            };
            if (proxyUrl) {
                options.proxy = proxyUrl;
            }
            if (cookiesFile) {
                options.cookies = cookiesFile;
            }

            await ytdlp(url, options, { timeout: timeoutMs });

            const file = await findNewestVideoFile(outputDir);
            if (!file) {
                throw new Error('Download finished, but no output video file was found.');
            }

            const info = await readReelInfoJson(outputDir);
            return { videoPath: file, info };
        } catch (err) {
            lastError = err;
            if (attempt <= maxRetries) {
                await sleep(1000 * attempt);
            }
        }
    }
    let hint = '';
    if (isInstagramAuthError(lastError)) {
        hint = cookiesFile
            ? ' Instagram rejected the request despite cookies — the session likely expired or the IP is flagged; '
              + 're-export a fresh logged-in "sessionid" cookie and/or use a residential proxy.'
            : ' Instagram now requires authentication for this reel — supply logged-in cookies via '
              + 'instagramCookiesJson (a "sessionid" cookie) and prefer a residential proxy.';
    }
    throw new Error(
        `Failed to download reel after ${maxRetries} attempts. Last error: ${lastError?.message || lastError}.${hint}`,
    );
}

async function transcribeWithGemini({ ai, model, videoPath, languageHint }) {
    const mimeType = lookupMime(videoPath) || 'video/mp4';

    const uploadedFile = await withGeminiRetry('files.upload', () =>
        ai.files.upload({
            file: videoPath,
            mimeType,
            config: { mimeType },
        }),
    );

    let file = uploadedFile;
    const maxPollTime = 10 * 60 * 1000;
    const pollInterval = 5000;
    const startTime = Date.now();

    while (!file.state || file.state.toString() !== 'ACTIVE') {
        if (file.state && file.state.toString() === 'FAILED') {
            throw new Error(`Gemini file processing failed: ${file.error?.message || 'Unknown error'}`);
        }
        if (Date.now() - startTime > maxPollTime) {
            throw new Error('Gemini file processing timed out after 10 minutes.');
        }
        await Actor.setStatusMessage(`Waiting for Gemini to process video... state is ${file.state || 'PROCESSING'}`);
        await sleep(pollInterval);
        file = await withGeminiRetry('files.get', () => ai.files.get({ name: uploadedFile.name }));
    }

    let promptText = 'Please provide a high-quality transcript of this video.';
    if (languageHint && languageHint !== 'auto') {
        promptText += ` The primary language of the video is likely ${languageHint}. Please transcribe it in that language.`;
    }

    await Actor.setStatusMessage('Generating transcript with Gemini...');

    const response = await withGeminiRetry('generateContent', () =>
        ai.models.generateContent({
            model: model || 'gemini-2.5-flash',
            contents: [
                createUserContent([
                    createPartFromUri(file.uri, file.mimeType),
                    promptText,
                ]),
            ],
        }),
    );

    return {
        uploadedFile: file,
        transcript: response.text,
    };
}

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const {
        reelUrl,
        model = 'gemini-2.5-flash',
        languageHint = 'auto',
        keepLocalVideo = false,
        maxRetries = 3,
        computeOutlierScore: shouldComputeOutlier = true,
        outlierSampleSize = 12,
        instagramCookiesJson,
        ytdlpUpdateChannel,
        proxyConfiguration: proxyInput,
    } = input;

    // API key must come from the secret env var only — never from input,
    // which would be stored in plaintext on the run record.
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable (Apify secret) is required.');
    }

    if (!isLikelyInstagramReelUrl(reelUrl)) {
        throw new Error('reelUrl must look like a public Instagram Reel URL (https://www.instagram.com/reel/...).');
    }

    // Resolve a proxy URL for the download. Residential proxy is strongly
    // recommended at scale so Instagram does not block Apify datacenter IPs.
    let proxyUrl;
    const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
    if (proxyConfiguration) {
        proxyUrl = await proxyConfiguration.newUrl();
        log.info('Using Apify Proxy for the Instagram download.');
    } else {
        log.warning('No proxy configured — Instagram may rate-limit or block datacenter IPs at scale.');
    }

    // Pull the freshest yt-dlp before downloading so we have the latest Instagram
    // extractor fixes. Best-effort — never blocks the run if the update fails.
    const updateChannel = getYtDlpUpdateChannel(ytdlpUpdateChannel);
    if (updateChannel !== 'none') {
        await Actor.setStatusMessage('Updating yt-dlp to the latest build...');
        await refreshYtDlpBinary(updateChannel);
    }

    const runId = Actor.getEnv().runId || crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), `reel-${runId}`);

    // Tracked so we can always clean up the remote Gemini file, even on failure.
    let geminiFileName;

    try {
        await Actor.setStatusMessage('Downloading reel video...');
        const { videoPath, info } = await downloadReel({
            url: reelUrl,
            outputDir: workDir,
            maxRetries,
            proxyUrl,
            instagramCookiesJson,
        });

        const videoStat = await fs.stat(videoPath);


        const stats = extractStats(info);
        const engagement = computeEngagement(stats);

        let outlier = { score: null, baseline: null, sampleSize: 0, reason: 'Outlier scoring disabled.' };
        if (shouldComputeOutlier) {
            await Actor.setStatusMessage('Computing outlier score from the account baseline...');
            outlier = await computeOutlierScore({
                views: stats.views,
                username: stats.username,
                proxyUrl,
                sampleSize: outlierSampleSize,
                timeoutMs: 4 * 60 * 1000,
                currentId: info?.id,
            });
            if (outlier.reason) {
                log.warning(`Outlier score not computed: ${outlier.reason}`);
            }
        }

        const metrics = {
            outlierScore: outlier.score,
            views: stats.views,
            likes: stats.likes,
            comments: stats.comments,
            followers: stats.followers,
            engagement: engagement.engagementRate,
            engagementRate: engagement.engagementRate,
            engagementRateByFollowers: engagement.engagementRateByFollowers,
            interactions: engagement.interactions,
            uploader: stats.uploader,
            username: stats.username,
            outlierBaseline: {
                medianViews: outlier.baseline,
                sampleSize: outlier.sampleSize,
                note: outlier.reason,
            },
        };

        await Actor.setStatusMessage('Uploading video to Gemini...');
        const ai = new GoogleGenAI({ apiKey });

        const geminiResult = await transcribeWithGemini({
            ai,
            model,
            videoPath,
            languageHint,
        });
        geminiFileName = geminiResult.uploadedFile.name;

        const output = {
            status: 'succeeded',
            sourceUrl: reelUrl,
            model,
            languageHint,
            // Convenience top-level fields (also grouped under `metrics`).
            outlierScore: metrics.outlierScore,
            views: metrics.views,
            likes: metrics.likes,
            comments: metrics.comments,
            followers: metrics.followers,
            engagement: metrics.engagement,
            metrics,
            localVideo: {
                path: videoPath,
                bytes: videoStat.size,
            },
            geminiFile: {
                name: geminiResult.uploadedFile.name,
                uri: geminiResult.uploadedFile.uri,
                mimeType: geminiResult.uploadedFile.mimeType,
                state: geminiResult.uploadedFile.state,
            },
            transcript: geminiResult.transcript,
            createdAt: new Date().toISOString(),
        };

        await Actor.pushData(output);
        await Actor.setValue('OUTPUT', output);
        await Actor.setStatusMessage('Done.');

        // Best-effort cleanup of the remote Gemini file.
        try {
            await ai.files.delete({ name: geminiFileName });
            geminiFileName = undefined;
        } catch (err) {
            log.warning(`Could not delete Gemini file ${geminiFileName}: ${err.message}`);
        }
    } catch (err) {
        // Surface a structured failure record so downstream consumers can see why.
        const failure = {
            status: 'failed',
            sourceUrl: reelUrl,
            model,
            error: err?.message || String(err),
            createdAt: new Date().toISOString(),
        };
        await Actor.pushData(failure);
        await Actor.setValue('OUTPUT', failure);

        // Make sure a leaked Gemini upload from a partial run is cleaned up so
        // it does not consume the Files API storage quota.
        if (geminiFileName) {
            try {
                const ai = new GoogleGenAI({ apiKey });
                await ai.files.delete({ name: geminiFileName });
            } catch (cleanupErr) {
                log.warning(`Could not delete leaked Gemini file ${geminiFileName}: ${cleanupErr.message}`);
            }
        }

        throw err; // re-throw so Apify marks the run as failed
    } finally {
        if (!keepLocalVideo) {
            try {
                await fs.rm(workDir, { recursive: true, force: true });
            } catch (err) {
                log.warning(`Could not clean up temp files: ${err.message}`);
            }
        }
    }
});
