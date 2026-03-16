/**
 * server/veo.mjs
 * Isolated Veo image-to-video module.
 *
 * Pipeline per turn:
 *   1. Fetch source image → base64
 *   2. POST to Veo generateVideos (Vertex AI, async)
 *   3. Poll operation until done (10 s intervals, 20 min timeout)
 *   4. Write raw video (≥4 s) to disk
 *   5. Trim to 1 s with ffmpeg → write clip to disk
 *   6. Return { rawPath, clipUrl }
 *
 * Required env vars:
 *   GOOGLE_CLOUD_PROJECT          — GCP project ID
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON (optional if ADC is set)
 *   VEO_LOCATION                  — defaults to "us-central1"
 *   VEO_MODEL                     — defaults to "veo-2.0-generate-001"
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const rootDir      = path.resolve(__dirname, '..');
const clipsDir     = path.join(rootDir, 'generated', 'clips');

if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

// ─── ffmpeg path ──────────────────────────────────────────────────────────────

// Resolve ffmpeg-static via CJS require (it ships a plain string default export)
const _require    = createRequire(import.meta.url);
const ffmpegPath  = (() => {
  try { return _require('ffmpeg-static'); } catch { return 'ffmpeg'; }
})();

// ─── Veo client (lazy) ───────────────────────────────────────────────────────

let _veoClient = null;

function getVeoClient() {
  if (_veoClient) return _veoClient;

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) throw new Error('[veo] GOOGLE_CLOUD_PROJECT is required');

  _veoClient = new GoogleGenAI({
    vertexai: true,
    project,
    location: process.env.VEO_LOCATION || 'us-central1',
  });
  return _veoClient;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch an image from a URL, local server path, or data URL and return { data, mimeType }.
 *
 * Supported cases:
 *   1. data:image/…  — decode base64 inline, persist to generated/ for debugging
 *   2. /generated/…  — read from disk directly (no HTTP round-trip)
 *   3. http(s)://…   — fetch from remote URL
 *   4. other relative — prefix serverBaseUrl and fetch
 */
async function fetchImageBase64(imageUrl, serverBaseUrl) {
  const urlType =
    imageUrl.startsWith('data:')       ? 'data-url'   :
    imageUrl.startsWith('/generated/') ? 'local-file'  :
    imageUrl.startsWith('http')        ? 'remote-http' : 'relative';

  console.log(`[veo] fetchImageBase64  type=${urlType}  urlLen=${imageUrl.length}`);

  // ── Case 1: data URL ─────────────────────────────────────────────────────
  if (urlType === 'data-url') {
    const commaIdx = imageUrl.indexOf(',');
    if (commaIdx === -1) throw new Error('[veo] malformed data URL: no comma found');

    const header   = imageUrl.slice(0, commaIdx);          // e.g. "data:image/png;base64"
    const b64Data  = imageUrl.slice(commaIdx + 1);         // raw base64 payload
    const mimeType = header.split(':')[1]?.split(';')[0] ?? 'image/png';
    const ext      = mimeType === 'image/png' ? '.png' : '.jpg';

    console.log(`[veo] data URL  header="${header}"  mimeType=${mimeType}  b64len=${b64Data.length}  preview="${b64Data.slice(0, 30)}"`);
    if (!b64Data || b64Data.length === 0) {
      throw new Error('[veo] data URL has empty base64 payload');
    }

    // Persist to disk so the job is self-contained and debuggable
    const filename = `clip-input-${Date.now()}${ext}`;
    const savePath = path.join(rootDir, 'generated', filename);
    const rawBuf   = Buffer.from(b64Data, 'base64');
    fs.writeFileSync(savePath, rawBuf);
    const fileSizeBytes = fs.statSync(savePath).size;
    console.log(`[veo] data URL saved  path=${savePath}  diskBytes=${fileSizeBytes}`);
    if (fileSizeBytes === 0) throw new Error('[veo] decoded image file is 0 bytes — data URL may be corrupt');

    return { data: b64Data, mimeType };
  }

  // ── Case 2: local /generated/… path — read from disk ────────────────────
  if (urlType === 'local-file') {
    const localPath = path.join(rootDir, imageUrl);
    if (!fs.existsSync(localPath)) throw new Error(`[veo] local image not found: ${localPath}`);
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    console.log(`[veo] local file  path=${localPath}  diskBytes=${buf.length}  mimeType=${mimeType}`);
    if (buf.length === 0) throw new Error(`[veo] local image file is 0 bytes: ${localPath}`);
    return { data: buf.toString('base64'), mimeType };
  }

  // ── Case 3 & 4: http(s) URL or other relative path — fetch ──────────────
  const base = serverBaseUrl || process.env.APP_URL || 'http://localhost:3001';
  const url  = imageUrl.startsWith('http') ? imageUrl : `${base}${imageUrl}`;
  console.log(`[veo] fetching remote image  url=${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[veo] image fetch failed: ${resp.status} ${url}`);
  const buf  = Buffer.from(await resp.arrayBuffer());
  const ct   = resp.headers.get('content-type') || 'image/jpeg';
  const mimeType = ct.split(';')[0].trim();
  console.log(`[veo] remote image fetched  bytes=${buf.length}  mimeType=${mimeType}  status=${resp.status}`);
  if (buf.length === 0) throw new Error(`[veo] remote image is 0 bytes: ${url}`);
  return { data: buf.toString('base64'), mimeType };
}

/**
 * Poll a Veo long-running operation until done.
 * Timeout: 20 minutes.
 */
async function pollOperation(client, operation) {
  const INTERVAL_MS  = 10_000;
  const TIMEOUT_MS   = 20 * 60 * 1000;
  const deadline     = Date.now() + TIMEOUT_MS;

  let op = operation;
  while (!op.done) {
    if (Date.now() > deadline) throw new Error('[veo] operation timed out after 20 min');
    await sleep(INTERVAL_MS);
    op = await client.operations.getVideosOperation({ operation: op });
    console.log(`[veo] polling… done=${op.done}`);
  }
  return op;
}

/**
 * Trim a video file to 1 second using ffmpeg.
 * Re-encodes to ensure clean seek point at t=0.
 */
async function trimToOneSecond(inputPath, outputPath) {
  // -ss 0 + -t 1 re-encodes the first second; -an drops audio
  await execFileAsync(ffmpegPath, [
    '-y',
    '-ss', '0',
    '-i', inputPath,
    '-t', '1',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-an',
    outputPath,
  ]);
}

// ─── In-memory job store ─────────────────────────────────────────────────────

/**
 * Simple in-process job map.
 * { [jobId]: { status: 'pending'|'done'|'error', clipUrl?, error? } }
 */
export const jobs = new Map();

let _jobCounter = 0;
function newJobId() { return `clip-${Date.now()}-${++_jobCounter}`; }

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a motion clip generation job.
 * Returns jobId immediately. Progress is tracked in the jobs map.
 *
 * @param {string}  imageUrl      — /generated/… path or full URL to source image
 * @param {string}  motionPrompt  — short cinematic motion description
 * @param {string}  turnId        — used to name output files
 * @param {string}  [serverBaseUrl]
 * @returns {string} jobId
 */
export function startMotionClip(imageUrl, motionPrompt, turnId, serverBaseUrl) {
  const jobId = newJobId();
  jobs.set(jobId, { status: 'pending' });

  // Fire-and-forget — status tracked in jobs map
  _runJob(jobId, imageUrl, motionPrompt, turnId, serverBaseUrl).catch(err => {
    console.error(`[veo] job ${jobId} FAILED: ${err.message}`);
    console.error(`[veo] job ${jobId} stack:`, err.stack);
    jobs.set(jobId, { status: 'error', error: err.message });
  });

  return jobId;
}

async function _runJob(jobId, imageUrl, motionPrompt, turnId, serverBaseUrl) {
  const model = process.env.VEO_MODEL || 'veo-2.0-generate-001';
  console.log(`[veo] job ${jobId} START  model=${model}  turn=${turnId}  imageUrl=${imageUrl}`);

  const client = getVeoClient();

  // 1. Fetch source image
  console.log(`[veo] job ${jobId} step=fetch-image`);
  const { data: imageBase64, mimeType } = await fetchImageBase64(imageUrl, serverBaseUrl);
  console.log(`[veo] job ${jobId} step=fetch-image OK  mimeType=${mimeType}  base64len=${imageBase64.length}`);

  // 2. Start generation
  if (!imageBase64 || imageBase64.length === 0) {
    throw new Error('[veo] imageBase64 is empty before generateVideos — image fetch returned no data');
  }
  const imagePayload = { imageBytes: imageBase64, mimeType };
  const requestConfig = {
    aspectRatio:     '16:9',
    durationSeconds: 5,
    numberOfVideos:  1,
  };
  console.log(
    `[veo] job ${jobId} step=generate-videos` +
    `  imageBytes.length=${imageBase64.length}` +
    `  imageBytes.preview="${imageBase64.slice(0, 20)}"` +
    `  mimeType=${mimeType}` +
    `  imagePayloadKeys=${JSON.stringify(Object.keys(imagePayload))}` +
    `  prompt="${motionPrompt.slice(0, 60)}…"`
  );
  console.log(`[veo] job ${jobId} REQUEST CONFIG durationSeconds=${requestConfig.durationSeconds}  full=${JSON.stringify(requestConfig)}`);
  let operation = await client.models.generateVideos({
    model,
    prompt: motionPrompt,
    image: imagePayload,
    config: requestConfig,
  });
  console.log(`[veo] job ${jobId} step=generate-videos OK  operation=${operation.name}`);

  // 3. Poll
  console.log(`[veo] job ${jobId} step=poll-operation`);
  operation = await pollOperation(client, operation);
  console.log(`[veo] job ${jobId} step=poll-operation OK`);

  // 4. Extract video bytes
  // SDK deserialization path (Vertex):
  //   raw: response.videos[n]._self.{ bytesBase64Encoded, gcsUri }
  //   → SDK maps to: response.generatedVideos[n].video.{ videoBytes, uri }
  console.log(`[veo] job ${jobId} step=extract-bytes`);
  console.log(`[veo] operation.done=${operation.done}`);
  console.log(`[veo] operation.error=${JSON.stringify(operation.error ?? null)}`);
  console.log(`[veo] operation.response keys=${JSON.stringify(Object.keys(operation.response ?? {}))}`);
  console.log(`[veo] operation.response full=${JSON.stringify(operation.response ?? null)}`);

  // Surface operation-level error first
  if (operation.error) {
    throw new Error(`[veo] operation completed with error: ${JSON.stringify(operation.error)}`);
  }

  const generatedVideos = operation.response?.generatedVideos ?? [];
  console.log(`[veo] generatedVideos.length=${generatedVideos.length}`);

  if (!generatedVideos.length) {
    // Log full response to expose content-filtering, empty results, etc.
    const raiCount = operation.response?.raiMediaFilteredCount ?? 0;
    const raiReasons = operation.response?.raiMediaFilteredReasons ?? [];
    console.error(`[veo] job ${jobId} no videos — raiFilteredCount=${raiCount}  reasons=${JSON.stringify(raiReasons)}`);
    console.error(`[veo] full response: ${JSON.stringify(operation.response ?? null)}`);
    const reason = raiCount > 0
      ? `video blocked by safety filter (${raiReasons.join(', ')})`
      : 'no videos returned in completed operation';
    throw new Error(`[veo] ${reason}`);
  }

  const videoObj = generatedVideos[0]?.video;
  console.log(`[veo] videoObj keys=${JSON.stringify(Object.keys(videoObj ?? {}))}`);

  // SDK maps inline bytes (bytesBase64Encoded) → videoBytes
  // SDK maps GCS path (gcsUri) → uri
  const videoData = videoObj?.videoBytes ?? null;
  const videoUri  = videoObj?.uri ?? null;
  console.log(`[veo] videoBytes.length=${videoData?.length ?? 'null'}  uri=${videoUri ?? 'null'}`);

  if (!videoData && !videoUri) {
    console.error(`[veo] job ${jobId} videoObj=${JSON.stringify(videoObj)}`);
    throw new Error('[veo] video has neither inline bytes nor a URI');
  }
  if (!videoData) {
    throw new Error(`[veo] video only has GCS URI (${videoUri}) — outputGcsUri download not implemented`);
  }
  console.log(`[veo] job ${jobId} step=extract-bytes OK  base64len=${videoData.length}`);

  // 5. Write video to disk — raw 5-second output served directly as the clip
  const safeId  = turnId.replace(/[^a-z0-9-]/gi, '-');
  const clipName = `veo-clip-${safeId}-${Date.now()}.mp4`;
  const clipPath = path.join(clipsDir, clipName);
  fs.writeFileSync(clipPath, Buffer.from(videoData, 'base64'));
  console.log(`[veo] job ${jobId} step=write-clip OK  path=${clipPath}`);

  const clipUrl = `/generated/clips/${clipName}`;
  jobs.set(jobId, { status: 'done', clipUrl });
  console.log(`[veo] job ${jobId} DONE  clipUrl=${clipUrl}`);
}
