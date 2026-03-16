/**
 * Balance Round 1 — Parameter Preset Comparison
 *
 * Runs 4 diagnostic evaluations × 3 presets, plus detailed turn tables
 * for the two most informative scenarios.
 *
 *   npx tsx scripts/balance.ts
 */

import {
  computePhase,
  INITIAL_OUTCOME_FIELDS,
  type TurnImpact,
  type OutcomeState,
} from '../src/outcomeEngine';

// ─── Parameterized engine (mirrors outcomeEngine.ts exactly) ──────────────────

interface Params {
  MAX_MOMENTUM: number;
  MOMENTUM_SCALE: number;
  UNSUPPORTED_DELTA_SCALE: number;
}

function applyWith(params: Params, state: OutcomeState, impact: TurnImpact): OutcomeState {
  const { progressA, outcome } = state;
  const { player, baseDelta, isCausallySupported, bonusAwarded, bonusAmount } = impact;
  const direction: 1 | -1 = player === 'A' ? 1 : -1;

  if (baseDelta <= 0) return { progressA, outcome: { ...outcome } };

  let newStreakPlayer: string | null;
  let newStreakCount: number;
  let newMomentum: number;
  let effectiveDelta: number;

  if (!isCausallySupported) {
    newStreakPlayer = null;
    newStreakCount  = 0;
    newMomentum     = Math.trunc(outcome.momentum / 2);
    effectiveDelta  = baseDelta * params.UNSUPPORTED_DELTA_SCALE;
  } else if (player === outcome.streakPlayer) {
    newStreakPlayer = player;
    newStreakCount  = outcome.streakCount + 1;
    newMomentum     = Math.max(-params.MAX_MOMENTUM, Math.min(params.MAX_MOMENTUM, outcome.momentum + direction));
    effectiveDelta  = baseDelta * (1 + Math.abs(newMomentum) * params.MOMENTUM_SCALE);
  } else {
    newStreakPlayer = player;
    newStreakCount  = 1;
    newMomentum     = direction * 1;
    effectiveDelta  = baseDelta * (1 + Math.abs(newMomentum) * params.MOMENTUM_SCALE);
  }

  if (bonusAwarded) effectiveDelta += bonusAmount;

  const newProgressA = Math.round(
    Math.max(0, Math.min(100, progressA + direction * effectiveDelta)) * 10,
  ) / 10;

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

function chain(params: Params, initial: OutcomeState, impacts: TurnImpact[]): OutcomeState {
  return impacts.reduce((s, imp) => applyWith(params, s, imp), initial);
}

function fresh(startProgress = 50): OutcomeState {
  return { progressA: startProgress, outcome: { ...INITIAL_OUTCOME_FIELDS, phase: computePhase(startProgress) } };
}

// ─── Impact builders ──────────────────────────────────────────────────────────

const A  = (d: number): TurnImpact => ({ player: 'A', baseDelta: d, isCausallySupported: true,  bonusAwarded: false, bonusAmount: 0 });
const B  = (d: number): TurnImpact => ({ player: 'B', baseDelta: d, isCausallySupported: true,  bonusAwarded: false, bonusAmount: 0 });
const An = (d: number): TurnImpact => ({ player: 'A', baseDelta: d, isCausallySupported: false, bonusAwarded: false, bonusAmount: 0 });

// ─── Evaluations ──────────────────────────────────────────────────────────────

/** 1. How many supported A turns (delta=8) from 50 to cross each phase boundary. */
function phaseLadder(params: Params) {
  let state = fresh(50);
  const r = { trend: 0, amplified: 0, lock: 0 };
  for (let i = 1; i <= 25; i++) {
    state = applyWith(params, state, A(8));
    if (!r.trend     && state.outcome.phase !== 'open')                                  r.trend     = i;
    if (!r.amplified && (state.outcome.phase === 'amplified' || state.outcome.phase === 'lock')) r.amplified = i;
    if (!r.lock      && state.outcome.phase === 'lock')                                  r.lock      = i;
    if (r.trend && r.amplified && r.lock) break;
  }
  return r;
}

/** 2. Total progress 5 unsupported A turns (delta=6) create from 50. */
function unsupportedTotal(params: Params): number {
  return Math.round((chain(params, fresh(50), Array(5).fill(An(6))).progressA - 50) * 10) / 10;
}

/** 3. A builds +3 momentum then B fires one supported counter (delta=8). */
function counterSnap(params: Params) {
  const afterA = chain(params, fresh(50), [A(8), A(8), A(8)]);
  const afterB = applyWith(params, afterA, B(8));
  return {
    trendPeak:  afterA.progressA,
    afterSnap:  afterB.progressA,
    recovered:  Math.round((afterA.progressA - afterB.progressA) * 10) / 10,
    bMomentum:  afterB.outcome.momentum,
  };
}

/** 4. Starting at 88 (amplified), B fires 4 supported moves (delta=12). */
function nearLock(params: Params) {
  const end = chain(params, fresh(88), [B(12), B(12), B(12), B(12)]);
  return { finalProgress: end.progressA, finalPhase: end.outcome.phase };
}

// ─── Detail table printer ─────────────────────────────────────────────────────

function fmt(n: number): string { return n > 0 ? `+${n}` : String(n); }

function detail(
  params: Params, presetName: string,
  startProgress: number, impacts: TurnImpact[],
) {
  let state = fresh(startProgress);
  const W = [6, 2, 4, 4, 5, 10, 11];
  const row = (...cols: string[]) => cols.map((c, i) => c.padEnd(W[i] ?? 10)).join(' ');

  console.log(`  [${presetName}]`);
  console.log('  ' + row('Turn', 'P', 'Δ', 'Sup', 'mom', 'progressA', 'phase'));
  console.log('  ' + row('─'.repeat(5), '─', '─'.repeat(3), '─'.repeat(3), '─'.repeat(4), '─'.repeat(9), '─'.repeat(9)));
  console.log('  ' + row('start', '—', '—', '—', fmt(state.outcome.momentum), state.progressA.toFixed(1), state.outcome.phase));

  impacts.forEach((imp, i) => {
    state = applyWith(params, state, imp);
    console.log('  ' + row(
      String(i + 1),
      imp.player,
      String(imp.baseDelta),
      imp.isCausallySupported ? '✓' : '✗',
      fmt(state.outcome.momentum),
      state.progressA.toFixed(1),
      state.outcome.phase,
    ));
  });
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const PRESETS: [string, Params][] = [
  ['A (Conservative)', { MAX_MOMENTUM: 4, MOMENTUM_SCALE: 0.06, UNSUPPORTED_DELTA_SCALE: 0.30 }],
  ['B (Balanced)',     { MAX_MOMENTUM: 5, MOMENTUM_SCALE: 0.08, UNSUPPORTED_DELTA_SCALE: 0.35 }],
  ['C (Dramatic)',     { MAX_MOMENTUM: 5, MOMENTUM_SCALE: 0.10, UNSUPPORTED_DELTA_SCALE: 0.50 }],
];

const bar  = '═'.repeat(72);
const dash = '─'.repeat(72);

console.log(`\n${bar}`);
console.log('  BALANCE ROUND 1 — PARAMETER PRESET COMPARISON');
console.log(`${bar}\n`);
console.log('  Params per preset:');
console.log('  Preset               MAX_MOM  MOM_SCALE  UNSUP_SCALE');
console.log('  ' + '─'.repeat(52));
for (const [name, p] of PRESETS) {
  console.log(`  ${name.padEnd(22)} ${String(p.MAX_MOMENTUM).padEnd(9)} ${String(p.MOMENTUM_SCALE).padEnd(11)} ${p.UNSUPPORTED_DELTA_SCALE}`);
}

// ── 1. Phase ladder ───────────────────────────────────────────────────────────
console.log(`\n${dash}`);
console.log('  1. PHASE LADDER — turns to exit each phase from 50 (A, delta=8, all supported)');
console.log(`${dash}`);
console.log('  Preset               → trend     → amplified  → lock');
console.log('  ' + '─'.repeat(52));
for (const [name, p] of PRESETS) {
  const r = phaseLadder(p);
  console.log(`  ${name.padEnd(22)} turn ${String(r.trend).padEnd(6)} turn ${String(r.amplified).padEnd(7)} turn ${r.lock}`);
}

// ── 2. Unsupported progress ───────────────────────────────────────────────────
console.log(`\n${dash}`);
console.log('  2. UNSUPPORTED PROGRESS — 5 unsupported A turns (delta=6) from 50');
console.log('     Full-rate equivalent (5×6=30, no momentum): would be +15.0 if 0.5×, +9.0 if 0.3×');
console.log(`${dash}`);
console.log('  Preset               total gained   % of 30.0 raw');
console.log('  ' + '─'.repeat(48));
for (const [name, p] of PRESETS) {
  const g = unsupportedTotal(p);
  const pct = Math.round((g / 30) * 100);
  console.log(`  ${name.padEnd(22)} +${g.toFixed(1).padEnd(14)} ${pct}%`);
}

// ── 3. Counter-move hardness ──────────────────────────────────────────────────
console.log(`\n${dash}`);
console.log('  3. COUNTER HARDNESS — A builds +3 momentum, then B fires 1 counter (delta=8)');
console.log(`${dash}`);
console.log('  Preset               A peak    after snap  B recovered  B mom');
console.log('  ' + '─'.repeat(56));
for (const [name, p] of PRESETS) {
  const r = counterSnap(p);
  console.log(`  ${name.padEnd(22)} ${r.trendPeak.toFixed(1).padEnd(10)} ${r.afterSnap.toFixed(1).padEnd(12)} −${String(r.recovered).padEnd(12)} ${fmt(r.bMomentum)}`);
}

// ── 4. Near-lock challenge ────────────────────────────────────────────────────
console.log(`\n${dash}`);
console.log('  4. NEAR-LOCK CHALLENGE — start=88 (amplified), B × 4 supported (delta=12)');
console.log(`${dash}`);
console.log('  Preset               final prog  final phase   verdict');
console.log('  ' + '─'.repeat(60));
for (const [name, p] of PRESETS) {
  const r = nearLock(p);
  const verdict = r.finalProgress <= 50
    ? '← full reversal (too easy)'
    : r.finalProgress < 70
    ? '← escaped trend (meaningful comeback)'
    : r.finalProgress < 80
    ? '← back to trend (credible comeback)'
    : r.finalProgress < 90
    ? '← still amplified (locked in, B struggling)'
    : '← still lock (near-lock unbreakable)';
  console.log(`  ${name.padEnd(22)} ${r.finalProgress.toFixed(1).padEnd(12)} ${r.finalPhase.padEnd(14)} ${verdict}`);
}

// ── Detail tables ─────────────────────────────────────────────────────────────
console.log(`\n${bar}`);
console.log('  DETAIL: Near-lock comeback (start=88, B×4 delta=12)');
console.log(`${bar}\n`);
for (const [name, p] of PRESETS) {
  detail(p, name, 88, [B(12), B(12), B(12), B(12)]);
}

console.log(`\n${bar}`);
console.log('  DETAIL: Counter interrupts trend (A×3 then B×3, delta=8)');
console.log(`${bar}\n`);
for (const [name, p] of PRESETS) {
  detail(p, name, 50, [A(8), A(8), A(8), B(8), B(8), B(8)]);
}

console.log('');
