/**
 * Outcome Engine
 *
 * Computes narrative momentum, streak tracking, and progress updates
 * for a two-player story-steering game. Framework-agnostic pure functions.
 *
 * Core principle:
 *   Momentum comes only from consecutive causally-supported moves in the
 *   same direction. Unsupported moves break the streak, decay momentum,
 *   and apply progress at a reduced rate — they never start or extend a streak.
 *
 * Integration: call applyTurnImpact() once per turn, write the returned
 * state back to GameState. See docs/ for the full spec.
 */

import { PlayerId } from './storyPacks';

// ─── Phase ────────────────────────────────────────────────────────────────────

/**
 * Four bands derived from |progressA − 50|.
 * Reflects how contested the narrative currently is.
 *
 *   open      |p − 50| <  20   (p ∈ 30–70)   neither side has a clear lean
 *   trend     |p − 50| <  30   (p ∈ 20–30 / 70–80)   a direction is forming
 *   amplified |p − 50| <  40   (p ∈ 10–20 / 80–90)   momentum compounding
 *   lock      |p − 50| >= 40   (p ∈  0–10 / 90–100)  near-decisive
 */
export type Phase = 'open' | 'trend' | 'amplified' | 'lock';

export function computePhase(progressA: number): Phase {
  const dist = Math.abs(progressA - 50);
  if (dist >= 40) return 'lock';
  if (dist >= 30) return 'amplified';
  if (dist >= 20) return 'trend';
  return 'open';
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * The outcome engine fields that live inside GameState.
 * Add these to GameState in types.ts when integrating.
 */
export interface OutcomeFields {
  /** Signed momentum. Positive = A-favoring, negative = B-favoring. Range −5 to +5. */
  momentum: number;
  /** Which player currently holds the streak. null when no streak is active. */
  streakPlayer: PlayerId | null;
  /**
   * Consecutive causally-supported turns by streakPlayer in the same direction.
   * Resets to 0 on any unsupported move. Resets to 1 when the other player
   * makes a supported move.
   */
  streakCount: number;
  /** Derived from progressA each turn. */
  phase: Phase;
}

export const INITIAL_OUTCOME_FIELDS: OutcomeFields = {
  momentum: 0,
  streakPlayer: null,
  streakCount: 0,
  phase: 'open',
};

// ─── Per-turn input ───────────────────────────────────────────────────────────

export interface TurnImpact {
  /** Which player is acting this turn. */
  player: PlayerId;
  /**
   * Raw unsigned progress delta from the GM (always >= 0).
   * Direction is inferred from player: A increases progressA, B decreases it.
   */
  baseDelta: number;
  /**
   * True when the move was narratively grounded:
   *   inapplicableIntent.length === 0 AND credibilityDelta >= 0
   * Only causally-supported moves extend the streak and earn full progress.
   */
  isCausallySupported: boolean;
  bonusAwarded: boolean;
  bonusAmount: number;
}

// ─── Parameters ───────────────────────────────────────────────────────────────

export const PARAMS = {
  /** Absolute cap on momentum. */
  MAX_MOMENTUM: 5,
  /** Momentum gained per additional streak turn (always 1 unit per turn). */
  MOMENTUM_PER_STREAK: 1,
  /** Each momentum point adds this fraction of baseDelta as bonus progress. */
  MOMENTUM_SCALE: 0.08,
  /**
   * Unsupported moves apply only this fraction of baseDelta to progress.
   * They still move the story, but cannot build advantage.
   */
  UNSUPPORTED_DELTA_SCALE: 0.35,
  /**
   * Lock resistance — dampens counter-directional moves when the story is
   * already leaning heavily to one side. A move is counter-directional when
   * direction × (progressA − 50) < 0 (i.e. fighting against the current lean).
   *
   * Applied as a multiplier on effectiveDelta after all other calculations:
   *   amplified phase  |p − 50| ∈ [30, 40)  →  × AMPLIFIED_COUNTER_RESIST
   *   lock phase       |p − 50| ∈ [40, 50]  →  × LOCK_COUNTER_RESIST
   *
   * Trend and open phases are unaffected — resistance only kicks in deep.
   */
  AMPLIFIED_COUNTER_RESIST: 0.60,
  LOCK_COUNTER_RESIST:      0.35,
} as const;

// ─── Core update ─────────────────────────────────────────────────────────────

export interface OutcomeState {
  progressA: number;  // 0–100
  outcome: OutcomeFields;
}

/**
 * applyTurnImpact
 *
 * Returns the new OutcomeState after one player's turn.
 * Pure function — does not mutate its arguments.
 *
 * Three streak/momentum cases (evaluated in this order):
 *
 *   CASE 0 — baseDelta <= 0 (no-progress turn)
 *     Streak and momentum are unchanged — a stalled turn earns nothing but
 *     costs nothing either. Progress is unchanged (delta is zero anyway).
 *     This check runs before causal support is evaluated.
 *
 *   CASE C — !isCausallySupported (either player)
 *     Streak broken: streakPlayer = null, streakCount = 0
 *     Momentum decays: trunc(momentum / 2)
 *     Progress reduced: baseDelta × UNSUPPORTED_DELTA_SCALE (no momentum bonus)
 *
 *   CASE A — isCausallySupported AND player === streakPlayer
 *     Streak extends: streakCount++
 *     Momentum accumulates: clamp(momentum + direction, −5, +5)
 *     Progress amplified: baseDelta × (1 + |newMomentum| × MOMENTUM_SCALE)
 *
 *   CASE B — isCausallySupported AND player !== streakPlayer
 *     Streak resets to 1 for the new player
 *     Momentum snaps to ±1 (no inheritance from prior streak)
 *     Progress: baseDelta × (1 + 1 × MOMENTUM_SCALE)
 *
 * After effectiveDelta is resolved, lock resistance is applied when the move
 * is counter-directional (fighting the current lean) in amplified or lock phase:
 *     amplified  →  effectiveDelta × AMPLIFIED_COUNTER_RESIST
 *     lock       →  effectiveDelta × LOCK_COUNTER_RESIST
 */
export function applyTurnImpact(
  state: OutcomeState,
  impact: TurnImpact,
): OutcomeState {
  const { progressA, outcome } = state;
  const { player, baseDelta, isCausallySupported, bonusAwarded, bonusAmount } = impact;

  const direction: 1 | -1 = player === 'A' ? 1 : -1;

  // CASE 0: no-progress turn — streak and momentum are frozen, progress unchanged.
  // A stalled turn should never build trend, even if the GM flagged it as causal.
  if (baseDelta <= 0) {
    return {
      progressA: state.progressA,
      outcome: { ...outcome },
    };
  }

  let newStreakPlayer: PlayerId | null;
  let newStreakCount: number;
  let newMomentum: number;
  let effectiveDelta: number;

  if (!isCausallySupported) {
    // CASE C: unsupported move
    // Breaks streak, decays momentum, applies reduced progress.
    newStreakPlayer = null;
    newStreakCount  = 0;
    newMomentum     = Math.trunc(outcome.momentum / 2);
    effectiveDelta  = baseDelta * PARAMS.UNSUPPORTED_DELTA_SCALE;

  } else if (player === outcome.streakPlayer) {
    // CASE A: continuing streak — same player, supported
    newStreakPlayer = player;
    newStreakCount  = outcome.streakCount + 1;
    newMomentum     = clamp(
      outcome.momentum + direction * PARAMS.MOMENTUM_PER_STREAK,
      -PARAMS.MAX_MOMENTUM,
      PARAMS.MAX_MOMENTUM,
    );
    effectiveDelta = baseDelta * (1 + Math.abs(newMomentum) * PARAMS.MOMENTUM_SCALE);

  } else {
    // CASE B: new player, supported — fresh streak at 1
    newStreakPlayer = player;
    newStreakCount  = 1;
    newMomentum     = direction * 1;
    effectiveDelta  = baseDelta * (1 + Math.abs(newMomentum) * PARAMS.MOMENTUM_SCALE);
  }

  if (bonusAwarded) {
    effectiveDelta += bonusAmount;
  }

  // Lock resistance: dampen counter-directional moves in amplified/lock phases.
  // Counter-directional = the move works against the currently advantaged side.
  // e.g. B moving when progressA > 50 (A is winning), or A moving when progressA < 50.
  const isCounterDirectional = direction * (progressA - 50) < 0;
  if (isCounterDirectional) {
    if (outcome.phase === 'lock') {
      effectiveDelta *= PARAMS.LOCK_COUNTER_RESIST;
    } else if (outcome.phase === 'amplified') {
      effectiveDelta *= PARAMS.AMPLIFIED_COUNTER_RESIST;
    }
  }

  // Round to 1 decimal place to prevent float drift accumulating over long games.
  const newProgressA = Math.round(clamp(progressA + direction * effectiveDelta, 0, 100) * 10) / 10;

  return {
    progressA: newProgressA,
    outcome: {
      momentum:     newMomentum,
      streakPlayer: newStreakPlayer,
      streakCount:  newStreakCount,
      phase:        computePhase(newProgressA),
    },
  };
}

// ─── Convenience builder ──────────────────────────────────────────────────────

/**
 * Assembles a TurnImpact from the raw GM result fields.
 * Call this in handleGenerate() after receiving the TurnResult.
 */
export function buildTurnImpact(
  player: PlayerId,
  prevProgressA: number,
  gmProgressA: number,
  inapplicableIntent: string[],
  credibilityDelta: number,
  bonusAwarded: boolean,
  bonusAmount: number,
): TurnImpact {
  return {
    player,
    baseDelta: Math.abs(gmProgressA - prevProgressA),
    isCausallySupported: inapplicableIntent.length === 0 && credibilityDelta >= 0,
    bonusAwarded,
    bonusAmount,
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
