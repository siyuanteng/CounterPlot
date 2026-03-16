/**
 * Shared types and pure (no-API) utilities used by both the frontend and
 * server/gemini.ts.  No AI SDK imports — safe to bundle in the browser.
 */

export interface DebugInfo {
  textModel: string;
  imageModel: string;
  lastError: string | null;
  show?: boolean;
  outcome?: {
    turn: number;
    player: string;
    prevProgressA: number;
    gmRawTarget: number;
    engineProgressA: number;
    baseDelta: number;
    isCausallySupported: boolean;
    bonusAwarded: boolean;
    bonusAmount: number;
    prevMomentum: number;
    newMomentum: number;
    prevPhase: string;
    newPhase: string;
    streakPlayer: string | null;
    streakCount: number;
  };
}

export type ActorId = 'player_a' | 'player_b';

export interface CharacterCanon {
  name: string;
  fixedAppearance: string;
  fixedOutfit: string;
  fixedProps: string[];
}

export interface CastEntry {
  displayName: string;
  roleLabel: string;
  appearance: string;
  outfit: string;
  props: string[];
}

export type CastTable = Record<ActorId, CastEntry>;

/** Build a CastTable from LLM-generated character canon + player names. Pure function. */
export function buildCastTable(
  canon: Record<string, CharacterCanon>,
  playerAName: string,
  playerBName: string,
): CastTable {
  const makeEntry = (playerName: string): CastEntry => {
    let found: CharacterCanon | undefined;
    const pLow = playerName.toLowerCase().replace(/\s+[ab]$/i, '').trim();
    for (const [key, entry] of Object.entries(canon)) {
      const kLow = (entry.name || key).toLowerCase().replace(/\s+[ab]$/i, '').trim();
      if (kLow === pLow || kLow.includes(pLow) || pLow.includes(kLow)) {
        found = entry;
        break;
      }
    }
    return {
      displayName: playerName,
      roleLabel:   playerName.replace(/\s+[AB]$/i, '').trim(),
      appearance:  found?.fixedAppearance ?? '',
      outfit:      found?.fixedOutfit     ?? '',
      props:       found?.fixedProps      ?? [],
    };
  };
  return {
    player_a: makeEntry(playerAName),
    player_b: makeEntry(playerBName),
  };
}
