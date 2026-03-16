/**
 * Outcome Engine Playtest Harness
 *
 * Developer-only balancing tool. No UI, no game pipeline.
 * Edit the SCENARIOS array below, then run:
 *
 *   npm run playtest
 *
 * Each scenario prints a compact turn-by-turn table showing how
 * progressA, momentum, streak, and phase evolve.
 */

import {
  applyTurnImpact,
  computePhase,
  INITIAL_OUTCOME_FIELDS,
  PARAMS,
  type TurnImpact,
  type OutcomeState,
} from '../src/outcomeEngine';

// ─── Scenario type ────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  startProgress?: number;       // default 50
  turns: TurnImpact[];
}

// ─── Compact impact builders ──────────────────────────────────────────────────

const A  = (delta: number): TurnImpact => ({ player: 'A', baseDelta: delta, isCausallySupported: true,  bonusAwarded: false, bonusAmount: 0 });
const B  = (delta: number): TurnImpact => ({ player: 'B', baseDelta: delta, isCausallySupported: true,  bonusAwarded: false, bonusAmount: 0 });
const An = (delta: number): TurnImpact => ({ player: 'A', baseDelta: delta, isCausallySupported: false, bonusAwarded: false, bonusAmount: 0 });
const Bn = (delta: number): TurnImpact => ({ player: 'B', baseDelta: delta, isCausallySupported: false, bonusAwarded: false, bonusAmount: 0 });
const AB = (delta: number, bonus: number): TurnImpact => ({ player: 'A', baseDelta: delta, isCausallySupported: true, bonusAwarded: true, bonusAmount: bonus });

// ─── Scenarios — edit freely ──────────────────────────────────────────────────

const SCENARIOS: Scenario[] = [

  {
    name: 'Balanced opening — alternating supported moves',
    turns: [A(8), B(8), A(8), B(8), A(8), B(8)],
    // Expect: momentum oscillates ±1, progress stays near 50, phase stays open
  },

  {
    name: 'Repeated supported A moves — momentum compounds',
    turns: [A(8), A(8), A(8), A(8), A(8)],
    // Expect: streak grows to 5, momentum +5 (capped), phase reaches amplified
  },

  {
    name: 'Repeated supported B moves — mirror of A',
    turns: [B(8), B(8), B(8), B(8), B(8)],
    // Expect: symmetric — streak −5 (capped), progress falls toward lock
  },

  {
    name: 'Unsupported noise turns — progress moves slowly, no streak builds',
    turns: [An(6), An(6), An(6), A(6), An(6), A(6)],
    // Expect: 3 unsupported → 0.5× delta each; supported turns start streak at 1
    // Streak never exceeds 1 since unsupported turns keep breaking it
  },

  {
    name: 'Counter-move interrupts trend — A at momentum +3, B snaps it',
    turns: [A(8), A(8), A(8), B(8), B(8), B(8)],
    // Expect: A builds +3, B snaps to −1 on first counter, then builds to −3
    // Progress recovers from ~79 back toward 50
  },

  {
    name: 'Near-lock comeback attempt — A near 90, B throws big supported moves',
    startProgress: 88,
    turns: [B(12), B(12), B(12), B(12)],
    // Expect: B starts at momentum −1 and builds; can they escape amplified before lock?
  },

];

// ─── Runner ───────────────────────────────────────────────────────────────────

function runScenario(scenario: Scenario): void {
  const startProgress = scenario.startProgress ?? 50;

  let state: OutcomeState = {
    progressA: startProgress,
    outcome: { ...INITIAL_OUTCOME_FIELDS, phase: computePhase(startProgress) },
  };

  // Header
  const bar = '─'.repeat(74);
  console.log(`\n${bar}`);
  console.log(`  ${scenario.name}`);
  console.log(`  params: MAX_MOMENTUM=${PARAMS.MAX_MOMENTUM}  MOMENTUM_SCALE=${PARAMS.MOMENTUM_SCALE}  UNSUPPORTED_SCALE=${PARAMS.UNSUPPORTED_DELTA_SCALE}`);
  console.log(bar);

  // Column headers
  console.log(
    row('Turn', 'P', 'Δ', 'Sup', 'streak', 'mom', 'progressA', 'phase'),
  );
  console.log(
    row('─'.repeat(4), '─', '─'.repeat(4), '─'.repeat(3), '─'.repeat(6), '─'.repeat(4), '─'.repeat(9), '─'.repeat(9)),
  );

  // Start row
  console.log(
    row(
      'start', '—', '—', '—',
      `${state.outcome.streakPlayer ?? 'null'}×${state.outcome.streakCount}`,
      fmt(state.outcome.momentum),
      state.progressA.toFixed(1),
      state.outcome.phase,
    ),
  );

  // Turn rows
  scenario.turns.forEach((impact, i) => {
    const next = applyTurnImpact(state, impact);
    console.log(
      row(
        String(i + 1),
        impact.player,
        impact.baseDelta === 0 ? '0' : String(impact.baseDelta),
        impact.isCausallySupported ? '✓' : '✗',
        `${next.outcome.streakPlayer ?? 'null'}×${next.outcome.streakCount}`,
        fmt(next.outcome.momentum),
        next.progressA.toFixed(1),
        next.outcome.phase,
      ),
    );
    state = next;
  });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function row(...cols: string[]): string {
  const widths = [5, 2, 5, 4, 8, 5, 10, 10];
  return cols.map((c, i) => c.padEnd(widths[i] ?? 10)).join(' ');
}

function fmt(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

SCENARIOS.forEach(runScenario);
console.log('');
