import { describe, it, expect } from 'vitest';
import {
  applyTurnImpact,
  computePhase,
  INITIAL_OUTCOME_FIELDS,
  type OutcomeState,
  type TurnImpact,
} from './outcomeEngine';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const start: OutcomeState = {
  progressA: 50,
  outcome: { ...INITIAL_OUTCOME_FIELDS },
};

function supported(player: 'A' | 'B', baseDelta: number): TurnImpact {
  return { player, baseDelta, isCausallySupported: true, bonusAwarded: false, bonusAmount: 0 };
}

function unsupported(player: 'A' | 'B', baseDelta: number): TurnImpact {
  return { player, baseDelta, isCausallySupported: false, bonusAwarded: false, bonusAmount: 0 };
}

/** Apply a sequence of impacts starting from an initial state. */
function chain(initial: OutcomeState, impacts: TurnImpact[]): OutcomeState {
  return impacts.reduce((s, impact) => applyTurnImpact(s, impact), initial);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ─── computePhase ─────────────────────────────────────────────────────────────

describe('computePhase', () => {
  it('returns open when |p − 50| < 20  (exclusive boundaries)', () => {
    expect(computePhase(50)).toBe('open');
    expect(computePhase(31)).toBe('open');
    expect(computePhase(69)).toBe('open');
  });

  it('returns trend when |p − 50| in [20, 30)  — boundaries 30 and 70 are trend', () => {
    expect(computePhase(30)).toBe('trend');  // dist=20 — first trend value
    expect(computePhase(70)).toBe('trend');  // dist=20
    expect(computePhase(29)).toBe('trend');
    expect(computePhase(71)).toBe('trend');
    expect(computePhase(21)).toBe('trend');
    expect(computePhase(79)).toBe('trend');
  });

  it('returns amplified for progress 10–20 and 80–90', () => {
    expect(computePhase(80)).toBe('amplified');
    expect(computePhase(89)).toBe('amplified');
    expect(computePhase(11)).toBe('amplified');
    expect(computePhase(19)).toBe('amplified');
  });

  it('returns lock for progress 0–10 and 90–100', () => {
    expect(computePhase(90)).toBe('lock');
    expect(computePhase(100)).toBe('lock');
    expect(computePhase(10)).toBe('lock');
    expect(computePhase(0)).toBe('lock');
  });
});

// ─── Example 1: repeated supported A moves ───────────────────────────────────

describe('repeated supported A moves', () => {
  it('builds streak, momentum, and amplified progress over three turns', () => {
    const t1 = applyTurnImpact(start, supported('A', 8));
    expect(t1.outcome.streakPlayer).toBe('A');
    expect(t1.outcome.streakCount).toBe(1);
    expect(t1.outcome.momentum).toBe(1);
    expect(round1(t1.progressA)).toBe(58.6); // 50 + 8×1.08

    const t2 = applyTurnImpact(t1, supported('A', 8));
    expect(t2.outcome.streakCount).toBe(2);
    expect(t2.outcome.momentum).toBe(2);
    expect(round1(t2.progressA)).toBe(67.9); // 58.6 + 8×1.16

    const t3 = applyTurnImpact(t2, supported('A', 8));
    expect(t3.outcome.streakCount).toBe(3);
    expect(t3.outcome.momentum).toBe(3);
    expect(round1(t3.progressA)).toBe(77.8); // 67.9 + 8×1.24
    expect(t3.outcome.phase).toBe('trend');  // |77.8−50|=27.8 ≥ 20
  });
});

// ─── Example 2: repeated supported B moves ───────────────────────────────────

describe('repeated supported B moves', () => {
  it('builds negative streak, momentum, and decreasing progress', () => {
    const t1 = applyTurnImpact(start, supported('B', 8));
    expect(t1.outcome.streakPlayer).toBe('B');
    expect(t1.outcome.momentum).toBe(-1);
    expect(round1(t1.progressA)).toBe(41.4); // 50 − 8×1.08

    const t2 = applyTurnImpact(t1, supported('B', 8));
    expect(t2.outcome.momentum).toBe(-2);
    expect(round1(t2.progressA)).toBe(32.1); // 41.4 − 8×1.16

    const t3 = applyTurnImpact(t2, supported('B', 8));
    expect(t3.outcome.momentum).toBe(-3);
    expect(round1(t3.progressA)).toBe(22.2); // 32.1 − 8×1.24
    expect(t3.outcome.phase).toBe('trend');
  });
});

// ─── Example 3: unsupported moves do not build momentum ──────────────────────

describe('unsupported moves', () => {
  it('do not start a streak or earn momentum', () => {
    const t1 = applyTurnImpact(start, unsupported('A', 5));
    expect(t1.outcome.streakPlayer).toBeNull();
    expect(t1.outcome.streakCount).toBe(0);
    expect(t1.outcome.momentum).toBe(0);
    expect(round1(t1.progressA)).toBe(51.8); // 50 + 5×0.35 (reduced rate)
  });

  it('apply reduced progress on two consecutive unsupported turns', () => {
    const t2 = chain(start, [unsupported('A', 5), unsupported('A', 5)]);
    expect(t2.outcome.streakPlayer).toBeNull();
    expect(t2.outcome.momentum).toBe(0);
    expect(round1(t2.progressA)).toBe(53.6); // 51.8 + 5×0.35
  });

  it('first supported move after unsupported turns starts streak at 1', () => {
    const t3 = chain(start, [
      unsupported('A', 5),
      unsupported('A', 5),
      supported('A', 5),
    ]);
    expect(t3.outcome.streakPlayer).toBe('A');
    expect(t3.outcome.streakCount).toBe(1);
    expect(t3.outcome.momentum).toBe(1);
    expect(round1(t3.progressA)).toBe(59.0); // 53.6 + 5×1.08
  });

  it('an unsupported move mid-streak breaks the streak completely', () => {
    // Build up a streak of 2, then fire an unsupported move
    const afterStreak = chain(start, [supported('A', 8), supported('A', 8)]);
    expect(afterStreak.outcome.streakCount).toBe(2);
    expect(afterStreak.outcome.momentum).toBe(2);

    const afterBreak = applyTurnImpact(afterStreak, unsupported('A', 8));
    expect(afterBreak.outcome.streakPlayer).toBeNull();
    expect(afterBreak.outcome.streakCount).toBe(0);
    expect(afterBreak.outcome.momentum).toBe(1); // trunc(2/2)
    // Progress only moves at 0.5×, not amplified
    expect(round1(afterBreak.progressA)).toBe(round1(afterStreak.progressA + 8 * 0.35));
  });
});

// ─── Example 4: counter-move interrupts an existing trend ────────────────────

describe('counter-move interrupts trend', () => {
  it('snaps momentum to ±1 for the new player, no inheritance', () => {
    // A builds momentum +3
    const trending = chain(start, [
      supported('A', 8),
      supported('A', 8),
      supported('A', 8),
    ]);
    expect(trending.outcome.momentum).toBe(3);
    expect(trending.outcome.streakPlayer).toBe('A');

    // B fires one supported counter-move
    const counter = applyTurnImpact(trending, supported('B', 8));
    expect(counter.outcome.streakPlayer).toBe('B');
    expect(counter.outcome.streakCount).toBe(1);
    expect(counter.outcome.momentum).toBe(-1); // snapped, not −3
    expect(round1(counter.progressA)).toBe(round1(trending.progressA - 8 * 1.08));
  });

  it('second B move continues streak from −1 to −2', () => {
    const trending = chain(start, [
      supported('A', 8),
      supported('A', 8),
      supported('A', 8),
    ]);
    const twoCounter = chain(trending, [supported('B', 8), supported('B', 8)]);
    expect(twoCounter.outcome.momentum).toBe(-2);
    expect(twoCounter.outcome.streakCount).toBe(2);
  });
});

// ─── Example 5: entry into amplified phase ───────────────────────────────────

describe('entry into amplified phase', () => {
  it('reaches trend after 4 consecutive supported A moves (delta=6)', () => {
    const result = chain(start, [
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
    ]);
    // Turn 1: 50 + 6×1.08 = 56.5
    // Turn 2: 56.5 + 6×1.16 = 63.5
    // Turn 3: 63.5 + 6×1.24 = 70.9  → trend
    // Turn 4: 70.9 + 6×1.32 = 78.8  → trend (|78.8−50|=28.8 < 30)
    expect(round1(result.progressA)).toBe(78.8);
    expect(result.outcome.phase).toBe('trend');
    expect(result.outcome.momentum).toBe(4);
    expect(result.outcome.streakCount).toBe(4);
  });
});

// ─── Example 6: entry into lock phase ────────────────────────────────────────

describe('entry into lock phase', () => {
  it('reaches lock after 6 consecutive supported A moves (delta=6)', () => {
    const result = chain(start, [
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
      supported('A', 6),
    ]);
    // Turn 5: 78.8 + 6×1.40 = 87.2  → amplified (momentum capped at 5)
    // Turn 6: 87.2 + 6×1.40 = 95.6  → lock
    expect(round1(result.progressA)).toBe(95.6);
    expect(result.outcome.phase).toBe('lock');
    expect(result.outcome.momentum).toBe(5); // capped
    expect(result.outcome.streakCount).toBe(6);
  });

  it('momentum caps at MAX_MOMENTUM and does not exceed it', () => {
    const result = chain(start, Array(10).fill(supported('A', 6)));
    expect(result.outcome.momentum).toBe(5);
  });
});

// ─── Bonus ────────────────────────────────────────────────────────────────────

describe('bonus', () => {
  it('adds bonus amount directly to effective delta', () => {
    const withBonus = applyTurnImpact(start, {
      player: 'A',
      baseDelta: 8,
      isCausallySupported: true,
      bonusAwarded: true,
      bonusAmount: 5,
    });
    // momentum=1 after Case B, eff = 8×1.08 + 5 = 13.64
    expect(round1(withBonus.progressA)).toBe(round1(50 + 8 * 1.08 + 5));
  });
});

// ─── Zero-delta guard ─────────────────────────────────────────────────────────

describe('zero-delta turns do not build streak or momentum', () => {
  it('a supported move with baseDelta=0 leaves streak and momentum unchanged', () => {
    const zeroDelta: TurnImpact = { player: 'A', baseDelta: 0, isCausallySupported: true, bonusAwarded: false, bonusAmount: 0 };

    // From cold start: no streak starts
    const fromStart = applyTurnImpact(start, zeroDelta);
    expect(fromStart.outcome.streakPlayer).toBeNull();
    expect(fromStart.outcome.streakCount).toBe(0);
    expect(fromStart.outcome.momentum).toBe(0);
    expect(fromStart.progressA).toBe(50); // unchanged

    // Mid-streak: streak and momentum are frozen, not incremented
    const afterStreak = chain(start, [supported('A', 8), supported('A', 8)]);
    expect(afterStreak.outcome.streakCount).toBe(2);
    expect(afterStreak.outcome.momentum).toBe(2);

    const afterZero = applyTurnImpact(afterStreak, zeroDelta);
    expect(afterZero.outcome.streakCount).toBe(2);  // not 3
    expect(afterZero.outcome.momentum).toBe(2);     // not 3
    expect(afterZero.progressA).toBe(afterStreak.progressA); // unchanged
  });

  it('the next non-zero supported turn after a zero-delta turn continues the streak normally', () => {
    const zeroDelta: TurnImpact = { player: 'A', baseDelta: 0, isCausallySupported: true, bonusAwarded: false, bonusAmount: 0 };
    const afterStreak = chain(start, [supported('A', 8), supported('A', 8)]);
    const afterZero   = applyTurnImpact(afterStreak, zeroDelta);

    // Next real turn: streak resumes from where it was frozen (count 2 → 3)
    const resumed = applyTurnImpact(afterZero, supported('A', 8));
    expect(resumed.outcome.streakCount).toBe(3);
    expect(resumed.outcome.momentum).toBe(3);
  });
});

// ─── Float rounding ───────────────────────────────────────────────────────────

describe('progressA rounding', () => {
  it('has at most 1 decimal place after every turn', () => {
    const result = chain(start, Array(20).fill(supported('A', 7)));
    const str = result.progressA.toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(1);
  });

  it('does not accumulate visible drift across 30 mixed turns', () => {
    const impacts = [
      ...Array(10).fill(supported('A', 7)),
      ...Array(10).fill(supported('B', 7)),
      ...Array(10).fill(unsupported('A', 5)),
    ];
    const result = chain(start, impacts);
    const str = result.progressA.toString();
    const decimals = str.includes('.') ? str.split('.')[1].length : 0;
    expect(decimals).toBeLessThanOrEqual(1);
  });
});

// ─── Progress clamping ────────────────────────────────────────────────────────

describe('progress clamping', () => {
  it('does not exceed 100', () => {
    const result = chain({ progressA: 98, outcome: { ...INITIAL_OUTCOME_FIELDS } },
      [supported('A', 20)]);
    expect(result.progressA).toBe(100);
  });

  it('does not go below 0', () => {
    const result = chain({ progressA: 2, outcome: { ...INITIAL_OUTCOME_FIELDS } },
      [supported('B', 20)]);
    expect(result.progressA).toBe(0);
  });
});
