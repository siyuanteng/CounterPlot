/**
 * Client-side API wrappers.  All AI calls go through the server — no API
 * keys or Gemini SDK in the browser.
 */
import type { CastTable } from '../geminiShared';

// ─── Turn text + image prompt ──────────────────────────────────────────────

export interface TurnTextApiResult {
  textResult: {
    sceneText: string;
    keyframePrompt: string;
    endingAProgress: number;
    endingBProgress?: number;
    inapplicableIntent: string[];
    inapplicableReason?: string;
    bonusAwarded?: boolean;
    bonusAmount?: number;
    credibilityDelta?: number;
    newEvidenceState?: string;
    newMediaState?: string;
    newTrustState?: string;
    opponentSummary?: string;
  };
  imagePrompt: string;
  usedTextModel: string;
  textError: string | null;
}

export async function generateTurnTextApi(params: {
  history: string;
  playerId: 'A' | 'B';
  intentText: string;
  progressA: number;
  characterLock: string;
  styleLock: string;
  credibility: number;
  evidenceState: string;
  mediaState: string;
  trustState: string;
  anchors: string[];
  sideQuestAlreadyEarned: boolean;
  currentTurn: number;
  intentScale: 'NORMAL' | 'FINAL';
  castTable: CastTable;
}): Promise<TurnTextApiResult> {
  const r = await fetch('/api/generate-turn-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`/api/generate-turn-text failed ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

// ─── Image generation ──────────────────────────────────────────────────────

export interface ImageApiResult {
  imageUrl: string;
  usedImageModel: string;
  imageError: string | null;
  imageFailed: boolean;
}

export async function generateImageApi(imagePrompt: string): Promise<ImageApiResult> {
  const r = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imagePrompt }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`/api/generate-image failed ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

// ─── Cover image ───────────────────────────────────────────────────────────

export async function generateCoverApi(prompt: string): Promise<string | null> {
  const r = await fetch('/api/generate-cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return d.imageUrl ?? null;
}

// ─── Character canon ───────────────────────────────────────────────────────

export async function characterCanonApi(params: {
  characterIdentityLock: string;
  playerAName: string;
  playerBName: string;
}): Promise<Record<string, any>> {
  const r = await fetch('/api/character-canon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!r.ok) return {};
  const d = await r.json().catch(() => ({}));
  return d.canon ?? {};
}

// ─── Translation ───────────────────────────────────────────────────────────

export async function translateApi(texts: string[]): Promise<Record<string, string>> {
  const r = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!r.ok) return {};
  const d = await r.json().catch(() => ({}));
  return d.translations ?? {};
}
