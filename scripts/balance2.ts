/**
 * Balance Round 2 — Lock Resistance Calibration
 *
 * Compares four resistance configurations against three near-lock scenarios.
 * Base params: Preset B (MAX_MOMENTUM=5, MOMENTUM_SCALE=0.08, UNSUP=0.35).
 *
 *   npx tsx scripts/balance2.ts
 */

import { computePhase, INITIAL_OUTCOME_FIELDS, type TurnImpact, type OutcomeState } from '../src/outcomeEngine';

// ─── Parameterized engine (Preset B base, variable resistance) ────────────────

interface Params {
  MAX_MOMENTUM: number;
  MOMENTUM_SCALE: number;
  UNSUPPORTED_DELTA_SCALE: number;
  AMPLIFIED_COUNTER_RESIST: number;  // 1.0 = no resistance
  LOCK_COUNTER_RESIST: number;       // 1.0 = no resistance
}

const BASE: Omit<Params, 'AMPLIFIED_COUNTER_RESIST' | 'LOCK_COUNTER_RESIST'> = {
  MAX_MOMENTUM: 5,
  MOMENTUM_SCALE: 0.08,
  UNSUPPORTED_DELTA_SCALE: 0.35,
};

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

  // Lock resistance
  const isCounterDirectional = direction * (progressA - 50) < 0;
  if (isCounterDirectional) {
    if (outcome.phase === 'lock')      effectiveDelta *= params.LOCK_COUNTER_RESIST;
    else if (outcome.phase === 'amplified') effectiveDelta *= params.AMPLIFIED_COUNTER_RESIST;
  }

  const newProgressA = Math.round(Math.max(0, Math.min(100, progressA + direction * effectiveDelta)) * 10) / 10;
  return {
    progressA: newProgressA,
    outcome: { momentum: newMomentum, streakPlayer: newStreakPlayer, streakCount: newStreakCount, phase: computePhase(newProgressA) },
  };
}

function chain(params: Params, initial: OutcomeState, impacts: TurnImpact[]): OutcomeState {
  return impacts.reduce((s, imp) => applyWith(params, s, imp), initial);
}

function fresh(p: number): OutcomeState {
  return { progressA: p, outcome: { ...INITIAL_OUTCOME_FIELDS, phase: computePhase(p) } };
}

const B = (d: number): TurnImpact => ({ player: 'B', baseDelta: d, isCausallySupported: true, bonusAwarded: false, bonusAmount: 0 });
const fmt = (n: number) => n > 0 ? `+${n}` : String(n);

// ─── Configs ──────────────────────────────────────────────────────────────────

const CONFIGS: [string, Params][] = [
  ['None (before)',            { ...BASE, AMPLIFIED_COUNTER_RESIST: 1.00, LOCK_COUNTER_RESIST: 1.00 }],
  ['Light  (A=0.70, L=0.50)', { ...BASE, AMPLIFIED_COUNTER_RESIST: 0.70, LOCK_COUNTER_RESIST: 0.50 }],
  ['Mod ★  (A=0.60, L=0.35)', { ...BASE, AMPLIFIED_COUNTER_RESIST: 0.60, LOCK_COUNTER_RESIST: 0.35 }],
  ['Strong (A=0.45, L=0.25)', { ...BASE, AMPLIFIED_COUNTER_RESIST: 0.45, LOCK_COUNTER_RESIST: 0.25 }],
];

// ─── Detail table ─────────────────────────────────────────────────────────────

function detail(params: Params, label: string, startProg: number, impacts: TurnImpact[]) {
  let state = fresh(startProg);
  const row = (...cols: string[]) => {
    const W = [5, 2, 3, 5, 10, 11];
    return '  ' + cols.map((c, i) => c.padEnd(W[i] ?? 10)).join(' ');
  };
  console.log(`  [${label}]`);
  console.log(row('Turn', 'P', 'Δ', 'mom', 'progressA', 'phase'));
  console.log(row('─'.repeat(4), '─', '─'.repeat(2), '─'.repeat(4), '─'.repeat(9), '─'.repeat(9)));
  console.log(row('start', '—', '—', fmt(state.outcome.momentum), state.progressA.toFixed(1), state.outcome.phase));
  impacts.forEach((imp, i) => {
    state = applyWith(params, state, imp);
    console.log(row(String(i + 1), imp.player, String(imp.baseDelta), fmt(state.outcome.momentum), state.progressA.toFixed(1), state.outcome.phase));
  });
  console.log('');
}

// ─── Summary table ────────────────────────────────────────────────────────────

function summaryRow(params: Params, startProg: number, impacts: TurnImpact[]) {
  const end = chain(params, fresh(startProg), impacts);
  const verdict =
    end.progressA >= 90 ? 'lock (barely moved)' :
    end.progressA >= 80 ? 'amplified (hard push)' :
    end.progressA >= 70 ? 'trend (credible comeback)' :
    end.progressA >= 50 ? 'open (strong comeback)' :
    'past center (full reversal)';
  return `${end.progressA.toFixed(1).padEnd(10)} ${end.outcome.phase.padEnd(12)} ${verdict}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const bar  = '═'.repeat(72);
const dash = '─'.repeat(72);

console.log(`\n${bar}`);
console.log('  BALANCE ROUND 2 — LOCK RESISTANCE CALIBRATION');
console.log('  Base: Preset B  (MAX_MOMENTUM=5, MOMENTUM_SCALE=0.08, UNSUP=0.35)');
console.log(`${bar}\n`);

// Scenario A: amplified (88) → B × 4 supported, delta=8
console.log(`${dash}`);
console.log('  SCENARIO A: from amplified (88), B × 4 supported, delta=8');
console.log('  Baseline: B makes 4 solid moves against a well-positioned A');
console.log(`${dash}`);
console.log('  Config                      final prog  final phase   verdict');
console.log('  ' + '─'.repeat(64));
for (const [name, p] of CONFIGS) {
  console.log(`  ${name.padEnd(28)} ${summaryRow(p, 88, [B(8), B(8), B(8), B(8)])}`);
}

// Scenario B: lock (93) → B × 4 supported, delta=8
console.log(`\n${dash}`);
console.log('  SCENARIO B: from lock (93), B × 4 supported, delta=8');
console.log('  Baseline: B fights against a near-decisive A position');
console.log(`${dash}`);
console.log('  Config                      final prog  final phase   verdict');
console.log('  ' + '─'.repeat(64));
for (const [name, p] of CONFIGS) {
  console.log(`  ${name.padEnd(28)} ${summaryRow(p, 93, [B(8), B(8), B(8), B(8)])}`);
}

// Scenario C: amplified (88) → B × 4, delta=12 (original playtest near-lock)
console.log(`\n${dash}`);
console.log('  SCENARIO C: from amplified (88), B × 4 supported, delta=12 (high-stakes)');
console.log('  Baseline: B makes 4 exceptional moves — original near-lock playtest');
console.log(`${dash}`);
console.log('  Config                      final prog  final phase   verdict');
console.log('  ' + '─'.repeat(64));
for (const [name, p] of CONFIGS) {
  console.log(`  ${name.padEnd(28)} ${summaryRow(p, 88, [B(12), B(12), B(12), B(12)])}`);
}

// Extended: lock (93) → B × 6, delta=8 (persistence test)
console.log(`\n${dash}`);
console.log('  SCENARIO D: from lock (93), B × 6 supported, delta=8 (persistence test)');
console.log('  Can a player in lock ever be genuinely threatened by a sustained push?');
console.log(`${dash}`);
console.log('  Config                      final prog  final phase   verdict');
console.log('  ' + '─'.repeat(64));
for (const [name, p] of CONFIGS) {
  console.log(`  ${name.padEnd(28)} ${summaryRow(p, 93, [B(8), B(8), B(8), B(8), B(8), B(8)])}`);
}

// Detail tables for recommended config
const [, MOD] = CONFIGS[2]!;

console.log(`\n${bar}`);
console.log('  DETAIL — Recommended config: Mod ★ (A=0.60, L=0.35)');
console.log(`${bar}\n`);

console.log('  Scenario A: amplified(88), B×4 delta=8\n');
detail(MOD, 'Mod ★', 88, [B(8), B(8), B(8), B(8)]);

console.log('  Scenario B: lock(93), B×4 delta=8\n');
detail(MOD, 'Mod ★', 93, [B(8), B(8), B(8), B(8)]);

console.log('  Scenario C: amplified(88), B×4 delta=12 (high-stakes)\n');
detail(MOD, 'Mod ★', 88, [B(12), B(12), B(12), B(12)]);

console.log('  Scenario D: lock(93), B×6 delta=8 (persistence)\n');
detail(MOD, 'Mod ★', 93, [B(8), B(8), B(8), B(8), B(8), B(8)]);

console.log('');
