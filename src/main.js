import { Actor, log } from 'apify';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { lookup as lookupMime } from 'mime-types';
import ytdlp from 'youtube-dl-exec';

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

async function downloadReel({ url, outputDir, maxRetries = 3, proxyUrl, timeoutMs = 5 * 60 * 1000 }) {
    await ensureDir(outputDir);

    const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');
    let lastError;

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
    throw new Error(
        `Failed to download reel after ${maxRetries} attempts. Last error: ${lastError?.message || lastError}`,
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
