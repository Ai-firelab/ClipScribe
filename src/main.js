import { Actor } from 'apify';
import { GoogleGenAI, createUserContent, createPartFromUri } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { lookup as lookupMime } from 'mime-types';
import ytdlp from 'youtube-dl-exec';

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

async function findNewestFile(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const files = [];

    for (const item of items) {
        if (!item.isFile()) continue;
        const full = path.join(dir, item.name);
        const stat = await fs.stat(full);
        files.push({ full, mtimeMs: stat.mtimeMs });
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.full ?? null;
}

async function downloadReel({ url, outputDir, maxRetries = 3 }) {
    await ensureDir(outputDir);

    const outputTemplate = path.join(outputDir, '%(id)s.%(ext)s');
    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            await ytdlp(url, {
                output: outputTemplate,
                noPlaylist: true,
                mergeOutputFormat: 'mp4',
                format: 'bv*+ba/b',
                retries: 2,
                quiet: true,
                noWarnings: true,
                // Add cookies later if you need authenticated access:
                // cookies: '/path/to/cookies.txt'
            });

            const file = await findNewestFile(outputDir);
            if (!file) {
                throw new Error('Download finished, but no output file was found.');
            }

            return file;
        } catch (err) {
            lastError = err;
            if (attempt <= maxRetries) {
                await sleep(1000 * attempt);
            }
        }
    }
    throw new Error(`Failed to download reel after ${maxRetries} attempts. Last error: ${lastError?.message || lastError}`);
}

async function transcribeWithGemini({ ai, model, videoPath, languageHint }) {
    const mimeType = lookupMime(videoPath) || 'video/mp4';

    const uploadedFile = await ai.files.upload({
        file: videoPath,
        mimeType,
        config: { mimeType },
    });

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
        file = await ai.files.get({ name: uploadedFile.name });
    }

    let promptText = 'Please provide a high-quality transcript of this video.';
    if (languageHint && languageHint !== 'auto') {
        promptText += ` The primary language of the video is likely ${languageHint}. Please transcribe it in that language.`;
    }

    await Actor.setStatusMessage('Generating transcript with Gemini...');

    const response = await ai.models.generateContent({
        model: model || 'gemini-2.5-flash',
        contents: [
            createUserContent([
                createPartFromUri(file.uri, file.mimeType),
                promptText,
            ]),
        ],
    });

    return {
        uploadedFile: file,
        transcript: response.text,
    };
}

await Actor.main(async () => {
    const input = await Actor.getInput() || {};
    const {
        reelUrl,
        model = 'gemini-2.5-flash',
        languageHint = 'auto',
        keepLocalVideo = false,
        maxRetries = 3,
        apiKey = process.env.GEMINI_API_KEY,
    } = input;

    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable or apiKey input parameter is required.');
    }

    if (!isLikelyInstagramReelUrl(reelUrl)) {
        throw new Error('reelUrl must look like a public Instagram Reel URL.');
    }

    const runId = Actor.getEnv().runId || crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), `reel-${runId}`);

    await Actor.setStatusMessage('Downloading reel video...');
    const videoPath = await downloadReel({
        url: reelUrl,
        outputDir: workDir,
        maxRetries,
    });

    const videoStat = await fs.stat(videoPath);

    await Actor.setStatusMessage('Uploading video to Gemini...');
    const ai = new GoogleGenAI({ apiKey });

    try {
        const geminiResult = await transcribeWithGemini({
            ai,
            model,
            videoPath,
            languageHint,
        });

        const output = {
            sourceUrl: reelUrl,
            model,
            languageHint,
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

        try {
            await ai.files.delete({ name: geminiResult.uploadedFile.name });
        } catch (err) {
            console.warn(`Could not delete Gemini file: ${err.message}`);
        }
    } finally {
        if (!keepLocalVideo) {
            try {
                await fs.rm(workDir, { recursive: true, force: true });
            } catch (err) {
                console.warn(`Could not clean up temp files: ${err.message}`);
            }
        }
    }
});