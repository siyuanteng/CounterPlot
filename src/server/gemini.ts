/// <reference types="vite/client" />
import { GoogleGenAI, Type, Schema } from '@google/genai';

const getApiKey = () => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.GEMINI_API_KEY || process.env.API_KEY;
  }
  return undefined;
};

const rawApiKey = (getApiKey() || import.meta.env?.VITE_GEMINI_API_KEY)?.trim().replace(/^["']|["']$/g, '');
const apiKey = (!rawApiKey || rawApiKey === 'undefined' || rawApiKey === 'null' || rawApiKey === 'MY_GEMINI_API_KEY') ? undefined : rawApiKey;
const ai = new GoogleGenAI({ apiKey: apiKey || 'mock' });

// Module-level cache to record successfully used models
let cachedTextModel: string | null = null;
let cachedImageModel: string | null = null;

export interface DebugInfo {
  textModel: string;
  imageModel: string;
  lastError: string | null;
  show?: boolean;
  /** Outcome engine snapshot for the last committed turn. */
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

export interface Panel {
  imageUrl: string;
  caption: string;
  failed?: boolean;
}

export interface TurnResult {
  sceneText: string;
  keyframePrompt: string;
  endingAProgress: number;
  endingBProgress: number;
  inapplicableIntent: string[];
  inapplicableReason?: string;
  bonusAwarded: boolean;
  bonusAmount: number;
  credibilityDelta: number;
  newEvidenceState: string;
  newMediaState: string;
  newTrustState: string;
  opponentSummary: string;
  panels: Panel[];
  debugInfo: DebugInfo;
}

export async function generateCoverImage(prompt: string): Promise<string | null> {
  if (!apiKey || apiKey === 'mock') {
    console.warn('No valid API key for image generation.');
    return null;
  }

  try {
    const res = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: prompt,
      config: {
        imageConfig: { aspectRatio: "3:4" }
      }
    });

    let base64 = null;
    for (const part of res.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        base64 = part.inlineData.data;
        break;
      }
    }
    
    if (base64) {
      return `data:image/jpeg;base64,${base64}`;
    }
  } catch (e) {
    console.error('Failed to generate cover:', e);
  }
  return null;
}

/**
 * Hidden candidate selection — called only from generateTurnText.
 * Passes sceneText from each candidate to the same model used for generation
 * and asks it to return the index of the best continuation.
 *
 * Selection criteria (mirrors rule #3 in the GM prompt):
 *   1. Consistency with prior context
 *   2. Natural causal progression (no unearned state jumps)
 *   3. Action scale preservation
 *   4. Suspense without melodrama
 *
 * Falls back to index 0 on any error.
 */
async function selectBestCandidate(
  history: string,
  intentText: string,
  candidates: any[],
  modelName: string,
): Promise<any> {
  if (candidates.length === 1) return candidates[0];

  const selectionPrompt = `You are a story quality evaluator. Your task is to select the best story continuation from ${candidates.length} candidates.

The player's narrative intent is the highest-authority input. It defines the direction, tone, and outcome of this scene. It is NOT a suggestion — it is a constraint on what the story does next.

EVALUATION RULES (apply in strict order):

RULE 1 — INTENT ADHERENCE (eliminates candidates):
The continuation must realize the player's stated narrative direction. Ask: "Does this scene move the story where the player intended?"
- If the intent calls for tension to build toward a confrontation, the scene must portray that tension accumulating.
- If the intent calls for a quiet observation beat, the scene must not escalate into direct conflict.
- A continuation that steers the story differently — no matter how well-written — is wrong. Disqualify it.

RULE 2 — SCOPE PRESERVATION (eliminates candidates):
The scene must not exceed the narrative scope declared in the intent. Dramatic delivery is allowed. Expanding what actually happens is not.

RULE 3 — CONTEXT CONSISTENCY (used to rank survivors):
Among candidates that passed Rules 1 and 2, prefer the one that is consistent with established facts and prior scene context.

RULE 4 — CAUSAL PROGRESSION (used to rank survivors):
Prefer natural cause-and-effect. No unearned state jumps.

RULE 5 — SUSPENSE WITHOUT MELODRAMA (tiebreaker):
If candidates are otherwise equal, prefer earned tension over artificially inflated drama.

If all candidates fail Rule 1, select the one that comes closest to realizing the declared narrative direction.

Recent story context:
"""
${history.slice(-500)}
"""

Player's narrative intent (this is the constraint — the scene must realize this direction):
"""
${intentText.slice(0, 400)}
"""

${candidates.map((c, i) => `Candidate ${i}:\n${c.sceneText}`).join('\n\n')}

Reply with a single digit only: 0, 1, or ${candidates.length - 1}.`;

  try {
    const res = await ai.models.generateContent({
      model: modelName,
      contents: selectionPrompt,
      config: { temperature: 0.1 },
    });
    const idx = parseInt((res.text || '').trim().match(/^\d/)?.[0] ?? '-1', 10);
    if (idx >= 0 && idx < candidates.length) {
      console.log(`[generateTurnText] candidate selection chose index ${idx}`);
      return candidates[idx];
    }
  } catch (e) {
    console.warn('[generateTurnText] candidate selection failed, using index 0:', e);
  }
  return candidates[0];
}

export async function generateTurnText(
  history: string,
  currentPlayer: 'A' | 'B',
  intentText: string,
  currentProgressA: number,
  characterLock: string,
  styleLock: string,
  credibility: number,
  evidenceState: string,
  mediaState: string,
  trustState: string,
  anchors: string[],
  sideQuestAlreadyEarned: boolean,
  currentTurn: number,
  intentScale: 'NORMAL' | 'FINAL'
) {
  const isA = currentPlayer === 'A';
  
  const mockResult = {
    sceneText: `[Mock Generation] Player ${currentPlayer} takes action. The terminal screen flickers with an eerie blue light, and the alarms seem to draw closer. The air is thick with tension; every step could determine the final outcome.`,
    keyframePrompt: `${characterLock} ${styleLock} neon lights, cyberpunk, intense atmosphere`,
    endingAProgress: isA ? Math.min(100, currentProgressA + 5) : Math.max(0, currentProgressA - 5),
    endingBProgress: isA ? Math.max(0, 100 - (currentProgressA + 5)) : Math.min(100, 100 - (currentProgressA - 5)),
    inapplicableIntent: Math.random() > 0.8 ? ['Attempted to use a broken communicator'] : [],
    inapplicableReason: 'The communicator was destroyed in the previous turn and must be repaired first.',
    bonusAwarded: false,
    bonusAmount: 0,
    credibilityDelta: 0,
    newEvidenceState: evidenceState,
    newMediaState: mediaState,
    newTrustState: trustState,
    opponentSummary: `Player ${currentPlayer} steers the story toward their narrative goal.`,
  };

  let textResult: any = null;
  let usedTextModel = 'mock';
  let textError: string | null = null;

  const prompt = `
You are the Game Master (GM) for a two-player collaborative storytelling game.

Story History:
${history}

Current State:
- Ending A Progress: ${currentProgressA}%
- Current Player: ${currentPlayer}
- Current Credibility: ${credibility}/100
- Evidence State: ${evidenceState} (Valid path: unknown -> located -> copied -> validated -> prepared -> shared -> published)
- Media State: ${mediaState} (Valid path: none -> drafted -> contacted -> trust_built -> handed_off -> published)
- Trust State: ${trustState} (Valid path: distant -> contact -> dialogue -> tension -> alignment -> cooperation)
- Story Anchor Elements: ${anchors.join(', ')}

Player ${currentPlayer}'s narrative intent — what they want to happen in this scene (Markdown format, containing Goal, Tone, Move, and Constraints):
${intentText}

// ─── NARRATIVE-STEERING GUARDRAIL ────────────────────────────────────────────
// Prevents the model from treating player input as character puppeteering.
// Players are story directors, not actors. Direct commands ("I pick the lock",
// "make her lie") must be reinterpreted as narrative outcomes, not staged
// literally. See docs/narrative-intent-regression.md for canonical test cases.
// Do not loosen or remove these rules without re-running that regression.
// ─────────────────────────────────────────────────────────────────────────────
INTENT INTERPRETATION (apply before all other rules):
The player's input may be written as a direct character command — imperative mood, first-person character action, or literal puppeteering of a named character. Do not treat these as literal stage directions. Instead, silently reinterpret them as narrative directions: the story outcome or tension that command implies.

STRICT REINTERPRETATION RULE:
The generated sceneText must NOT preserve the exact action verb structure from the command input. Do not simply convert first-person commands into third-person character choreography — that is still puppeteering, just with the pronoun changed. The scene must shift to what the action PRODUCES, not what it IS.

ADDITIONAL RULE — DO NOT OPEN WITH THE COMMANDED EVENT:
The opening sentence of the scene must be anchored to something that was already true before the command — a character's position, an ongoing tension, a physical detail from prior context. The commanded direction may only appear through its effects on that pre-existing state: a behavioral shift, a sensory absence, a change in another character's attention. Never name or directly describe the commanded event itself, even in paraphrase.

Specifically:
- Do not name or directly describe the commanded event in ANY sentence of the scene — not just the opening.
- Do not use the commanded action as a subject, object, or cause in any sentence ("A klaxon sounds", "The room went dark", "A red light washes over the racks", "A click from the wall panel" are all still the event named directly ✗).
- Do not have Alpha or Beta perform the commanded action in any form in any sentence.
- The entire scene must operate only through downstream effects: behavioral shifts in other characters, sensory or relational states that have changed, the altered conditions that now govern what is possible.
- DO open with another character's reaction to what has changed, OR with a description of the prior-state scene element that is now under pressure, OR with a sensory or relational shift that implies the event without naming it.

Examples of correct openings:
- "make the alarm go off" → "The security officer's hand froze over the comm unit." (reaction, not event)
- "kill the lights" → "The terminal readout was the last thing with clear edges." (prior-state detail now under threat)
- "have A confront B" → "The drones were still two minutes out, but that was no longer the operative pressure in the room." (relational shift without staging the confrontation)

Prohibited patterns (do not do this):
- "I pick the lock" → "Rescuer B uses tools and picks the lock." ✗ (choreography)
- "make her lie" → "Agent A tells a lie to the guard." ✗ (literal execution)
- "have A confront B" → "Agent A walks up to Agent B and confronts them." ✗ (puppeteering)
- "make the alarm go off" → "A klaxon slices through the air." ✗ (command staged as opening beat)
- "kill the lights" → "The room plunged into darkness." ✗ (command staged as opening beat)

Required patterns (do this instead):
- Consequence: what the action causes to become true in the world of the story
- Threshold: a barrier, seal, or status that shifts from one state to another
- Access: what becomes reachable, visible, or possible that was not before
- Exposure: what comes to light that was previously concealed
- Pressure: what force accumulates in the scene as a result
- Suspicion: what another party now begins to register or doubt
- Reversal: what changes direction, collapses, or inverts
- Delay: what is forestalled, complicated, or put under threat

Interpretation examples:
- "I pick the lock" → A sealed threshold begins to give way. The space beyond it — until now closed off — becomes imminent. The risk of what entry means rises alongside the possibility of it.
- "make her lie" → The information landscape of the scene shifts. What another party can trust becomes uncertain; a false picture takes hold and begins to do its work.
- "have A confront B" → The ambient tension between them crystallizes into something direct. A truth that had been circling the edges of the scene is now forced toward the surface.
- "make him open the door" → A transition point is crossed. What was sealed becomes accessible; the story moves from a state of blocked potential to one of exposed consequence.
- "force her to confess" → The structural concealment of the scene begins to fracture. Something previously withheld pushes toward the surface — not as a delivered speech, but as a crack in what has been held together.

Apply this reinterpretation silently. Do not mention the reinterpretation in sceneText. The generated scene should reflect the narrative outcome the command implies, not a literal mechanical execution of the command.

INTENT SCALE: ${intentScale}
${intentScale === 'FINAL'
  ? `This is the final turn and the story has reached sufficient momentum for a resolution.

FINAL MOVE:
- The scene may resolve into an ending consistent with the story's current trajectory.
- Even in FINAL, preserve causality — only resolve what the current narrative state actually supports.
- The ending must emerge from the accumulated story state, not be imposed.`
  : currentTurn < 10
  ? `NORMAL MOVE:
- The scene may advance the story, increase pressure, reveal clues, shift trust, or create a new opening.
- It must NOT resolve the match, deliver a full ending, or complete the player's end-state in one turn.
- If the player's wording sounds like a decisive ending action, reinterpret it as setup, approach, or partial breakthrough instead of full completion.
- At most one meaningful state advance per relevant track.`
  : `This is the final turn, but the story has not reached sufficient momentum for a decisive resolution.

NORMAL MOVE (forced — final-eligibility is false):
- The scene must NOT resolve into a match ending. Do not declare a winner or complete the player's end-state.
- Treat the player's intent as a powerful late-game push that does not fully land.
- Write as near-resolution, failed closure, or unresolved climax — leave the outcome structurally open.`}

CRITICAL FAIRNESS CONSTRAINTS & MECHANICS:
1. State Machine Thresholds: Narrative intents must follow the valid paths of the state machines and cannot skip steps. For example, if media_state is "none", the story cannot jump directly to "published" or "handed_off"; it must advance to "drafted" or "contacted" first.
2. Overreach Penalty: If a player's intent tries to skip steps (e.g., publishing immediately, destroying all evidence in one beat), you MUST:
   - Mark that part of the intent as inapplicable (inapplicableIntent) and explain why in inapplicableReason (e.g., "Partial intent inapplicable: Must complete [Draft/Contact] prerequisite steps first.").
   - Downgrade the narrative of this turn to the next valid story step.
   - Deduct credibility (credibilityDelta = -5).
3. Scope Preservation: The scene must realize the player's stated narrative direction at the scale they declared. It may intensify dramatic delivery, but must not expand what actually happens beyond the declared intent.
4. Procedural Justice Reward: If the narrative direction maintains procedural justice — preserving the chain of evidence, avoiding premature reveals, protecting innocents — reward credibility (credibilityDelta = +2).
5. Hidden Side Quest (Milestone Bonus — once per player per match, earliest turn 3):
   Current turn: ${currentTurn}. Side quest status for this player: ${sideQuestAlreadyEarned ? 'ALREADY EARNED — set bonusAwarded = false, bonusAmount = 0. Do not award again.' : currentTurn < 3 ? 'TOO EARLY — side quest cannot be awarded before turn 3. Set bonusAwarded = false, bonusAmount = 0.' : 'NOT YET EARNED — evaluate strictly below.'}
   The side quest is a rare milestone bonus, NOT a per-turn reward. It must represent a specific, decisive narrative turning point — not casual thematic alignment or repeated steering toward the theme.
   - Player A Milestone: The scene depicts an unambiguous, irreversible moment where verifiable evidence formally enters public record without collateral harm — not merely a step toward it, not casual mention of the theme. The turning point must be explicit in sceneText.
   - Player B Milestone: The scene depicts an unambiguous, irreversible moment where evidence is formally witnessed, sealed, or copied to a protected third party — not merely a step toward it, not casual mention of the theme. The turning point must be explicit in sceneText.
   - Anchor Quest: The scene explicitly depicts a named Story Anchor Element playing a central, plot-decisive role — incidental mention does not qualify.
   - If uncertain whether the milestone has truly been reached, set bonusAwarded = false (err on the side of strictness).
   - If bonusAwarded = true, set bonusAmount to an integer between 4 and 8. Otherwise bonusAmount = 0.
6. Progress Calculation:
   - Evaluate the driving force of the player's intent towards Ending A or Ending B, and provide a base progress increment (raw_delta, usually between 0 and 15).
   - The final effective increment MUST be influenced by current credibility: effective_delta = raw_delta * (0.5 + ${credibility}/200).
   - If it is Player A's turn, endingAProgress increases by effective_delta. If it is Player B's turn, endingAProgress decreases by effective_delta.
   - Ensure endingAProgress remains between 0 and 100.

PROSE QUALITY CONSTRAINTS (apply to sceneText only):
- Write from what is physically observable — including behavior, hesitation, glance direction, timing, and interpersonal reaction. Do not narrate abstract emotional states directly, but allow a character's actions and responses to imply them. Forensic or technical precision is appropriate only when the player's declared tone calls for it; otherwise prefer human-scaled detail over measurements or clinical description.
- Avoid stock suspense phrases: "oppressive hum", "crushing pressure", "heavy silence", "eerie glow", "something felt wrong", "the air was thick", "a chill ran down", "cold sweat". If tension is needed, render it through a specific observed detail, a behavioral cue, or a concrete action with an uncertain result.
- Do not stack adjectives to signal atmosphere. One precise detail — physical, behavioral, or interpersonal — is stronger than three evocative ones.
- Do not invent interpretive claims the characters have not earned. If a symbol has not been decoded, do not call it a "map or warning". If a sound has not been explained, do not assert "the anomaly is reacting". Describe only what is visible.
- Vary sentence rhythm and opening words across turns. Do not begin consecutive sentences with the same subject or pattern.
- Keep the scene vocabulary consistent with the established setting. Do not introduce new named objects, locations, or character knowledge that was not previously established unless the player's intent explicitly introduces them.

Please perform the following actions and return JSON:
1. sceneText: Generate the next scene text (4-6 sentences, in English), advancing the story. Must strictly follow the tone specified in the player's intent and the prose quality constraints above. If the player skipped steps, only describe the downgraded valid action.
2. keyframePrompt: An English prompt for generating a keyframe image. Must include character constraints (${characterLock}) and style constraints (${styleLock}), combined with the core actions/elements from the newly generated scene text.
3. endingAProgress: The calculated new progress for Ending A (integer 0-100).
4. inapplicableIntent: Array containing intent fragments that conflict with previous text or attempt to skip steps (in English). Empty array if none.
5. inapplicableReason: String explaining why the intent was inapplicable (in English). Empty string if none.
6. bonusAwarded: Boolean, whether a hidden side quest or anchor quest was achieved.
7. bonusAmount: Integer, the progress bonus value (4-8) if bonusAwarded is true; otherwise 0.
8. credibilityDelta: Integer, the change in credibility (e.g., -5, 0, or +2).
9. newEvidenceState: String, the updated evidence chain state.
10. newMediaState: String, the updated media chain state.
11. newTrustState: String, the updated trust chain state.
12. opponentSummary: 1-2 sentence summary of the narrative direction declared (in English), to be shown to the opponent as a hint about what their rival is steering toward.
`;

  const responseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      sceneText: { type: Type.STRING, description: '4-6 sentences of scene description (English)' },
      keyframePrompt: { type: Type.STRING, description: 'English prompt for image generation, must include character and style constraints' },
      endingAProgress: { type: Type.INTEGER, description: 'New progress for Ending A (0-100)' },
      inapplicableIntent: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of intents conflicting with previous text or skipping steps (English), empty array if none' },
      inapplicableReason: { type: Type.STRING, description: 'Explanation of why intent is inapplicable (English), empty string if none' },
      bonusAwarded: { type: Type.BOOLEAN, description: 'Whether a hidden side quest was achieved' },
      bonusAmount: { type: Type.INTEGER, description: 'Bonus progress value (4-8)' },
      credibilityDelta: { type: Type.INTEGER, description: 'Change in credibility (-5, 0, +2)' },
      newEvidenceState: { type: Type.STRING, description: 'Updated evidence chain state' },
      newMediaState: { type: Type.STRING, description: 'Updated media chain state' },
      newTrustState: { type: Type.STRING, description: 'Updated trust chain state' },
      opponentSummary: { type: Type.STRING, description: '1-2 sentence summary of intent (English), shown to opponent' },
    },
    required: ['sceneText', 'keyframePrompt', 'endingAProgress', 'inapplicableIntent', 'bonusAwarded', 'bonusAmount', 'credibilityDelta', 'newEvidenceState', 'newMediaState', 'newTrustState', 'opponentSummary'],
  };

  if (apiKey && apiKey !== 'mock') {
    const textCandidates = [
      import.meta.env?.VITE_GEMINI_TEXT_MODEL,
      cachedTextModel,
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview'
    ].filter(Boolean) as string[];
    
    const uniqueTextCandidates = Array.from(new Set(textCandidates));

    for (const modelName of uniqueTextCandidates) {
      try {
        const callOnce = (temperature: number) =>
          ai.models.generateContent({
            model: modelName,
            contents: prompt,
            config: { responseMimeType: 'application/json', responseSchema, temperature },
          }).then(res => {
            const parsed = JSON.parse(res.text || '{}');
            if (!parsed.sceneText || typeof parsed.endingAProgress !== 'number')
              throw new Error('Parsed JSON missing required fields');
            return parsed;
          });

        // Generate 3 candidates in parallel with temperature variation for diversity
        const results = await Promise.allSettled([
          callOnce(0.6),
          callOnce(0.75),
          callOnce(0.9),
        ]);

        const valid = results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
          .map(r => r.value);

        if (valid.length === 0) {
          const firstErr = (results[0] as PromiseRejectedResult).reason;
          textError = firstErr?.message || String(firstErr);
          console.warn(`Text model ${modelName} failed (all 3 candidates):`, textError);
          continue;
        }

        textResult = await selectBestCandidate(history, intentText, valid, modelName);
        usedTextModel = modelName;
        cachedTextModel = modelName;
        textError = null;
        break;
      } catch (error: any) {
        textError = error.message || String(error);
        console.warn(`Text model ${modelName} failed:`, textError);
        continue;
      }
    }
  }

  if (!textResult) {
    textResult = mockResult;
    if (!textError && (!apiKey || apiKey === 'mock')) {
      textError = 'No API Key provided, using mock.';
    }
  }

  return { textResult, usedTextModel, textError };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Actor identity — stable IDs separate from user-visible display names
// ─────────────────────────────────────────────────────────────────────────────

/** Stable internal actor identifier — never changes regardless of display name. */
export type ActorId = 'player_a' | 'player_b';

/** Per-turn pose/expression for one actor — no appearance or outfit data. */
export interface CharacterPose {
  actorId: ActorId;
  pose: string;
  facialExpression: string;
  bodyOrientation: string;
}

export interface SceneVisualBrief {
  /** Who is present and how they are posed — identified by stable actorId. */
  visibleCharacters: CharacterPose[];
  location: string;
  action: string;
  mustShowProps: string[];
  emotionVisible: string;
  cameraDistance: string;
  cameraAngle: string;
  compositionGoal: string;
  negativeConstraints: string[];
}

/** Fixed cross-turn identity for one character. Generated once per story. */
export interface CharacterCanon {
  name: string;
  fixedAppearance: string;
  fixedOutfit: string;
  fixedProps: string[];
}

/** One row in the cast table — display name + fixed visual identity. */
export interface CastEntry {
  displayName: string;   // user-entered name shown in UI and story text
  roleLabel: string;     // role word extracted from displayName (e.g. "Captain" from "Captain A")
  appearance: string;    // fixed physical appearance across all turns
  outfit: string;        // fixed outfit across all turns
  props: string[];       // fixed signature props always carried
}

/** Story-level cast — keyed by stable actorId. */
export type CastTable = Record<ActorId, CastEntry>;

/**
 * Build a CastTable from the LLM-generated character canon and authoritative
 * player names.  The canon provides appearance/outfit/props; the player names
 * provide displayName and the stable actorId mapping.
 *
 * Player names are the authority — the canon is keyed by them.
 */
export function buildCastTable(
  canon: Record<string, CharacterCanon>,
  playerAName: string,
  playerBName: string,
): CastTable {
  const makeEntry = (playerName: string): CastEntry => {
    // Try to find the matching canon entry by name similarity
    let found: CharacterCanon | undefined;
    const pLow = playerName.toLowerCase().replace(/\s+[ab]$/i, '').trim(); // role only
    for (const [key, entry] of Object.entries(canon)) {
      const kLow = (entry.name || key).toLowerCase().replace(/\s+[ab]$/i, '').trim();
      if (kLow === pLow || kLow.includes(pLow) || pLow.includes(kLow)) {
        found = entry;
        break;
      }
    }
    return {
      displayName: playerName,
      roleLabel: playerName.replace(/\s+[AB]$/i, '').trim(),
      appearance: found?.fixedAppearance ?? '',
      outfit:     found?.fixedOutfit     ?? '',
      props:      found?.fixedProps      ?? [],
    };
  };

  return {
    player_a: makeEntry(playerAName),
    player_b: makeEntry(playerBName),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Prompt sanitization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace any raw actorId tokens ("player_a" / "player_b") in a free-text field
 * with the human-readable label for that actor (displayName → roleLabel fallback).
 */
function resolveActorIdsInText(text: string, castTable: CastTable): string {
  if (!text) return text;
  const label = (id: ActorId) =>
    castTable[id].displayName || castTable[id].roleLabel || id;
  return text
    .replace(/\bplayer_a\b/gi, label('player_a'))
    .replace(/\bplayer_b\b/gi, label('player_b'));
}

/**
 * Sanitize negativeConstraints:
 * - Strip any entry that references an internal actorId or a cast member's
 *   displayName / roleLabel — those have no place in a visual avoid-list.
 * - Replace the entire set of removed entries with a single neutral visual
 *   constraint ("no additional characters in the scene").
 * - For single-character scenes, always append "only one person visible".
 */
function sanitizeNegativeConstraints(
  constraints: string[],
  visibleCount: number,
  castTable: CastTable,
): string[] {
  const actorIds: ActorId[] = ['player_a', 'player_b'];

  // Build the full set of forbidden tokens (lower-case)
  const forbidden = new Set<string>(['player_a', 'player_b']);
  for (const id of actorIds) {
    const e = castTable[id];
    if (e.displayName) forbidden.add(e.displayName.toLowerCase());
    if (e.roleLabel)   forbidden.add(e.roleLabel.toLowerCase());
  }

  const isCharacterRef = (c: string): boolean => {
    const low = c.toLowerCase();
    for (const token of forbidden) {
      if (token && low.includes(token)) return true;
    }
    return false;
  };

  const sanitized: string[] = [];
  let addedNeutral = false;

  for (const c of constraints) {
    if (isCharacterRef(c)) {
      if (!addedNeutral) {
        sanitized.push('no additional characters in the scene');
        addedNeutral = true;
      }
    } else {
      sanitized.push(c);
    }
  }

  if (visibleCount === 1 && !sanitized.includes('only one person visible')) {
    sanitized.push('only one person visible');
  }

  return sanitized;
}

/**
 * Build the final image prompt from a SceneVisualBrief + CastTable.
 *
 * Character identity is driven exclusively by actorId lookup in the cast table —
 * no name parsing, no alias resolution, no fuzzy matching.
 *
 * Block order:
 *   1. STYLE
 *   2. SCENE  (location · action · mood · composition goal)
 *   3. CAMERA (from brief, never overridden)
 *   4. MUST SHOW  (characters with full appearance + current pose · props)
 *   5. AVOID
 */
export function buildImagePromptFromBrief(
  brief: SceneVisualBrief,
  styleLock: string,
  castTable: CastTable,
): string {
  // ── 1. STYLE ───────────────────────────────────────────────────────────────
  const styleBlock = `STYLE: ${styleLock}`;

  // ── 2. SCENE ───────────────────────────────────────────────────────────────
  const sceneBlock = [
    'SCENE:',
    `  Location: ${brief.location}`,
    `  Action happening now: ${brief.action}`,
    `  Visible emotion / mood: ${brief.emotionVisible}`,
    `  Composition goal: ${brief.compositionGoal}`,
  ].join('\n');

  // ── 3. CAMERA ──────────────────────────────────────────────────────────────
  const cameraBlock = `CAMERA: ${brief.cameraDistance}, ${brief.cameraAngle}`;

  // ── 4. MUST SHOW ───────────────────────────────────────────────────────────
  const actorIds = brief.visibleCharacters.map(p => p.actorId);
  console.log('[IMAGE DEBUG] actorIds from brief\n', actorIds);

  const characterLines: string[] = [];
  const renderedLabels: { actorId: string; label: string }[] = [];

  for (const pose of brief.visibleCharacters) {
    const cast = castTable[pose.actorId];
    console.log('[IMAGE DEBUG] cast lookup result\n', { actorId: pose.actorId, cast });

    if (!cast) {
      console.warn(`[IMAGE WARNING] unknown actorId "${pose.actorId}" — skipping character`);
      continue;
    }

    // Never output raw actorIds — use displayName, fall back to roleLabel
    const label = (cast.displayName && cast.displayName.trim())
      ? cast.displayName.trim()
      : cast.roleLabel.trim() || pose.actorId;
    renderedLabels.push({ actorId: pose.actorId, label });

    characterLines.push(...[
      `  • ${label}`,
      cast.appearance ? `    Appearance: ${cast.appearance}` : '',
      cast.outfit     ? `    Outfit: ${cast.outfit}`         : '',
      cast.props.length > 0 ? `    Props: ${cast.props.join(', ')}` : '',
      `    Current pose: ${pose.pose}`,
      `    Facial expression: ${pose.facialExpression}`,
      `    Body orientation: ${pose.bodyOrientation}`,
    ].filter(Boolean));
  }

  console.log('[IMAGE DEBUG] rendered prompt character labels\n', renderedLabels);

  const mustShowLines: string[] = [];
  if (characterLines.length > 0) {
    mustShowLines.push(
      'Characters visible in this scene (authoritative — do not add, rename, or change their outfit):',
      ...characterLines,
    );
  }
  if (brief.mustShowProps.length > 0) {
    mustShowLines.push('Props:', ...brief.mustShowProps.map(p => `  • ${p}`));
  }
  const mustShowBlock = mustShowLines.length > 0
    ? `MUST SHOW (authoritative scene facts):\n${mustShowLines.join('\n')}`
    : '';

  // ── 5. AVOID ───────────────────────────────────────────────────────────────
  // negativeConstraints are already sanitized by compileSceneVisualBrief.
  // For single-character scenes, guarantee the constraint is present here too.
  const avoidList = [...brief.negativeConstraints];
  if (brief.visibleCharacters.length === 1 && !avoidList.includes('only one person visible')) {
    avoidList.push('only one person visible');
  }
  console.log('[IMAGE DEBUG] sanitized negative constraints\n', avoidList);
  const avoidBlock = avoidList.length > 0 ? `AVOID: ${avoidList.join(', ')}` : '';

  const prompt = [styleBlock, sceneBlock, cameraBlock, mustShowBlock, avoidBlock]
    .filter(Boolean)
    .join('\n\n');

  if (!prompt.includes(brief.cameraDistance) || !prompt.includes(brief.cameraAngle)) {
    console.warn('[IMAGE WARNING] Camera in final prompt does not match brief.',
      { expected: `${brief.cameraDistance}, ${brief.cameraAngle}` });
  }

  return prompt;
}

/**
 * Distils raw narrative prose into a structured SceneVisualBrief.
 * visibleCharacters uses actorId enum values ("player_a" | "player_b") — never
 * free-text names — so no alias resolution is needed after parsing.
 */
export async function compileSceneVisualBrief(
  sceneText: string,
  castTable: CastTable,
): Promise<SceneVisualBrief> {
  const fallback: SceneVisualBrief = {
    visibleCharacters: [],
    location: sceneText.slice(0, 80),
    action: sceneText.slice(0, 120),
    mustShowProps: [],
    emotionVisible: 'tense',
    cameraDistance: 'medium shot',
    cameraAngle: 'eye level',
    compositionGoal: 'dynamic framing, strong contrast',
    negativeConstraints: ['no text', 'no speech bubbles', 'no captions'],
  };

  if (!apiKey || apiKey === 'mock') return fallback;

  const playerAName = castTable.player_a.displayName;
  const playerBName = castTable.player_b.displayName;

  const prompt = `You are a storyboard artist. Given a story passage, extract ONLY what is physically visible in a single cinematic frame. Ignore internal thoughts, abstract concepts, off-screen events, and future outcomes.

The story has two characters:
- player_a = ${playerAName}
- player_b = ${playerBName}

CRITICAL: For visibleCharacters[].actorId use ONLY the values "player_a" or "player_b".
Never use character names, role labels, or any other string in the actorId field.

For each visible character also describe:
- pose: their current physical pose or action (e.g. "crouching behind a console")
- facialExpression: visible facial expression (e.g. "jaw clenched, eyes narrowed")
- bodyOrientation: how they face relative to camera (e.g. "facing away, head turned left")
Do NOT include outfit, clothing, equipment, or appearance in the pose fields.

Story passage:
"""
${sceneText}
"""

Return a JSON object with these exact fields:
- visibleCharacters: array of objects, each with actorId ("player_a"|"player_b"), pose, facialExpression, bodyOrientation
- location: string — the precise physical setting visible (surfaces, lighting, atmosphere)
- action: string — the dominant physical action happening RIGHT NOW in the frame
- mustShowProps: string[] — key physical objects that must appear in the image
- emotionVisible: string — the dominant visible emotion or tension readable from faces/body language
- cameraDistance: string — one of: extreme wide, wide, medium full, medium, medium close-up, close-up, extreme close-up
- cameraAngle: string — one of: eye level, low angle, high angle, dutch tilt, overhead, over-the-shoulder
- compositionGoal: string — one sentence on framing, depth, light direction, or visual tension
- negativeConstraints: string[] — what must NOT appear (e.g. "no text overlay", "no floating UI elements")`;

  const characterPoseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      actorId: { type: Type.STRING, enum: ['player_a', 'player_b'] },
      pose: { type: Type.STRING },
      facialExpression: { type: Type.STRING },
      bodyOrientation: { type: Type.STRING },
    },
    required: ['actorId', 'pose', 'facialExpression', 'bodyOrientation'],
  };

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      visibleCharacters: { type: Type.ARRAY, items: characterPoseSchema },
      location: { type: Type.STRING },
      action: { type: Type.STRING },
      mustShowProps: { type: Type.ARRAY, items: { type: Type.STRING } },
      emotionVisible: { type: Type.STRING },
      cameraDistance: { type: Type.STRING },
      cameraAngle: { type: Type.STRING },
      compositionGoal: { type: Type.STRING },
      negativeConstraints: { type: Type.ARRAY, items: { type: Type.STRING } },
    },
    required: ['visibleCharacters', 'location', 'action', 'mustShowProps', 'emotionVisible', 'cameraDistance', 'cameraAngle', 'compositionGoal', 'negativeConstraints'],
  };

  const candidates = [
    import.meta.env?.VITE_GEMINI_TEXT_MODEL,
    cachedTextModel,
    'gemini-3-flash-preview',
    'gemini-2.5-flash-preview-05-20',
  ].filter(Boolean) as string[];

  for (const modelName of Array.from(new Set(candidates))) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3 },
      });
      const raw = (response.text || '').trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const brief = JSON.parse(match[0]) as SceneVisualBrief;

      // Validate: every actorId must be a known key
      for (const pose of brief.visibleCharacters ?? []) {
        if (pose.actorId !== 'player_a' && pose.actorId !== 'player_b') {
          console.warn(`[IMAGE WARNING] invalid actorId "${pose.actorId}" returned by model — dropping entry`);
        }
      }
      brief.visibleCharacters = (brief.visibleCharacters ?? [])
        .filter(p => p.actorId === 'player_a' || p.actorId === 'player_b');

      // Replace any stray "player_a"/"player_b" tokens in free-text fields
      brief.action          = resolveActorIdsInText(brief.action, castTable);
      brief.location        = resolveActorIdsInText(brief.location, castTable);
      brief.emotionVisible  = resolveActorIdsInText(brief.emotionVisible, castTable);
      brief.compositionGoal = resolveActorIdsInText(brief.compositionGoal, castTable);

      // Strip character references from negativeConstraints; add neutral visual limits
      brief.negativeConstraints = sanitizeNegativeConstraints(
        brief.negativeConstraints ?? [],
        brief.visibleCharacters.length,
        castTable,
      );

      return brief;
    } catch (e) {
      console.warn(`[compileSceneVisualBrief] ${modelName} failed:`, e);
    }
  }

  console.warn('[compileSceneVisualBrief] all models failed, using fallback');
  return fallback;
}

/**
 * Generates a story-level CharacterCanon from the characterIdentityLock string.
 * Call once per session; the result should be cached and reused across turns.
 * Returns a map keyed by each character's canonical name (e.g. "The Captain").
 */
export async function generateCharacterCanon(
  characterIdentityLock: string,
  playerAName: string,
  playerBName: string,
): Promise<Record<string, CharacterCanon>> {
  const fallback: Record<string, CharacterCanon> = {};

  if (!apiKey || apiKey === 'mock' || !characterIdentityLock.trim()) return fallback;

  const prompt = `You are a character designer. Given a character identity description for a story, extract a fixed visual canon for each character.

Character identity description:
"""
${characterIdentityLock}
"""

The canonical names for the two characters are:
- Player A: "${playerAName}"
- Player B: "${playerBName}"

For each character, extract:
- name: the canonical name to use (use the provided canonical names above, not role labels like "Rescuer A")
- fixedAppearance: physical appearance — height, build, hair, skin tone, distinguishing features
- fixedOutfit: exact clothing and suit description
- fixedProps: array of signature equipment or items always carried

Return a JSON array of character canon objects.`;

  const canonSchema: Schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        fixedAppearance: { type: Type.STRING },
        fixedOutfit: { type: Type.STRING },
        fixedProps: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['name', 'fixedAppearance', 'fixedOutfit', 'fixedProps'],
    },
  };

  const candidates = [
    import.meta.env?.VITE_GEMINI_TEXT_MODEL,
    cachedTextModel,
    'gemini-3-flash-preview',
    'gemini-2.5-flash-preview-05-20',
  ].filter(Boolean) as string[];

  for (const modelName of Array.from(new Set(candidates))) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { responseMimeType: 'application/json', responseSchema: canonSchema, temperature: 0.1 },
      });
      const raw = (response.text || '').trim();
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) continue;
      const entries: CharacterCanon[] = JSON.parse(match[0]);
      const result: Record<string, CharacterCanon> = {};
      for (const entry of entries) {
        if (entry.name) result[entry.name] = entry;
      }
      console.log('[IMAGE DEBUG] character canon\n', JSON.stringify(result, null, 2));
      return result;
    } catch (e) {
      console.warn(`[generateCharacterCanon] ${modelName} failed:`, e);
    }
  }

  console.warn('[generateCharacterCanon] all models failed, returning empty canon');
  return fallback;
}

export async function generateImageOnly(imagePrompt: string): Promise<{ imageUrl: string, usedImageModel: string, imageError: string | null, imageFailed: boolean }> {
  let imageUrl = `https://picsum.photos/seed/${encodeURIComponent(imagePrompt || 'cyberpunk')}/800/400`;
  let usedImageModel = 'placeholder';
  let imageError: string | null = null;
  let imageFailed = true;

  if (apiKey && apiKey !== 'mock' && imagePrompt) {
    const imageCandidates = [
      import.meta.env?.VITE_GEMINI_IMAGE_MODEL,
      cachedImageModel,
      'gemini-2.5-flash-image',
      'gemini-3.1-flash-image-preview'
    ].filter(Boolean) as string[];
    
    const uniqueImageCandidates = Array.from(new Set(imageCandidates));

    for (const modelName of uniqueImageCandidates) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: imagePrompt,
          config: {
            imageConfig: {
              aspectRatio: "4:3"
            }
          }
        });

        let base64Data = null;
        let mimeType = 'image/jpeg';
        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
              base64Data = part.inlineData.data;
              mimeType = part.inlineData.mimeType || 'image/jpeg';
              break;
            }
          }
        }

        if (base64Data) {
          imageUrl = `data:${mimeType};base64,${base64Data}`;
          usedImageModel = modelName;
          cachedImageModel = modelName;
          imageError = null;
          imageFailed = false;
          break;
        } else {
          throw new Error('No image data returned in response');
        }
      } catch (error: any) {
        imageError = error.message || String(error);
        console.warn(`Image model ${modelName} failed:`, imageError);
        if (error.status === 'NOT_FOUND' || error.code === 404 || imageError.includes('404') || imageError.includes('not found')) {
          continue;
        }
        break;
      }
    }
  }

  return { imageUrl, usedImageModel, imageError, imageFailed };
}

export async function generateDraft(
  goal: string,
  tone: string,
  evidenceState: string,
  mediaState: string,
  trustState: string,
  anchors: string[],
  history: string
): Promise<string> {
  const prompt = `
You are an AI assistant for a two-player collaborative storytelling game. Please help the player draft a short narrative intent — a direction for what should happen in the next scene.

The player is not a character in the story. They are an author steering the plot from outside. The intent should describe what the story does next, not what a character decides to do.

If the player's notes or context contain direct character commands (e.g. "make her lie", "have him open the door", "I pick the lock"), reinterpret them as narrative directions before drafting. Do not convert the command into third-person character choreography — that is still puppeteering. Do not open the draft with the commanded event as a fait accompli. Instead write toward the consequence, threshold, access, or pressure the command implies, entering the scene at the moment just before or just after the event — never staging the command itself as the first beat.

Current State:
- Player Goal: ${goal}
- Desired Tone: ${tone}
- Evidence State: ${evidenceState} (Valid path: unknown -> located -> copied -> validated -> prepared -> shared -> published)
- Media State: ${mediaState} (Valid path: none -> drafted -> contacted -> trust_built -> handed_off -> published)
- Trust State: ${trustState} (Valid path: distant -> contact -> dialogue -> tension -> alignment -> cooperation)
- Story Anchor Elements: ${anchors.join(', ')}

Story History:
${history}

Requirements:
1. Generate a draft in Markdown format.
2. Include two sections: Move and Constraints. Separate them with ***.
3. Move should be 2-3 sentences describing the narrative direction — what the scene should do, what tension or development should unfold. Must follow the state machine and cannot skip steps. Prioritize involving an anchor element.
4. Constraints should be 1-2 lines describing scope limits or tonal requirements for this scene.
5. Do not include Goal and Tone declarations, just write Move and Constraints.
6. Write from the perspective of a story director, not a character. Third-person or outcome-focused framing preferred.
7. The output MUST be in English.

Example Format:
Move:
The scene cuts to the archive room — the encrypted ledger terminal is in reach, but the security sweep is moments away. The tension should sit on the threshold of action, not yet committed.

***
Constraints:
- Keep the tone taut and quiet — no direct confrontation yet.
- The atmosphere of the space should do the heavy lifting.
`;

  if (apiKey && apiKey !== 'mock') {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { temperature: 0.7 }
      });
      return response.text || '';
    } catch (e) {
      console.warn('Draft generation failed:', e);
    }
  }

  return `Move:\n[Mock Draft] The scene moves toward the ${anchors[0] || 'key location'} — something there will shift what comes next.\n\n***\nConstraints:\n- Keep the tone ${tone}.\n- Let the space and detail carry the tension, not direct statement.`;
}

export async function generateHook(history: string, anchors: string[]): Promise<string> {
  const prompt = `
You are an AI assistant for a two-player collaborative storytelling game. Based on the current story history, generate a short "Random Narrative Hook".
This hook should be a single sentence providing a new clue, a pressure point, a misunderstanding, a countdown, or an anomaly to inspire the player.

Story History:
${history}
Anchor Elements: ${anchors.join(', ')}

Requirements:
1. Output only one sentence.
2. Must be short and suspenseful.
3. Can (but doesn't have to) relate to the anchor elements.
4. The output MUST be in English.
`;

  if (apiKey && apiKey !== 'mock') {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { temperature: 0.8 }
      });
      return response.text?.trim() || '';
    } catch (e) {
      console.warn('Hook generation failed:', e);
    }
  }

  const mockHooks = [
    `You seem to hear a faint ticking sound coming from the ${anchors[0] || 'corner'}.`,
    'A burst of indecipherable static suddenly erupts from the communicator.',
    'You notice a set of footprints on the ground that belong to neither of you.',
    'The lights in the distance flicker suddenly, then go out completely.'
  ];
  return mockHooks[Math.floor(Math.random() * mockHooks.length)];
}

/**
 * Translate an array of story texts to Simplified Chinese.
 * Returns a map from original text → translated text.
 */
export async function translateStory(texts: string[]): Promise<Record<string, string>> {
  if (!apiKey || apiKey === 'mock' || texts.length === 0) {
    return {};
  }

  const prompt = `Translate each story passage below into Simplified Chinese (简体中文). Return a JSON array of translated strings in the same order. Passage count: ${texts.length}.\n\n${texts.map((t, i) => `[${i}] ${t}`).join('\n\n')}`;

  const candidates = [
    import.meta.env?.VITE_GEMINI_TEXT_MODEL,
    cachedTextModel,
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-2.5-flash-preview-05-20',
  ].filter(Boolean) as string[];

  const uniqueCandidates = Array.from(new Set(candidates));

  for (const modelName of uniqueCandidates) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: { type: Type.ARRAY, items: { type: Type.STRING } },
          temperature: 0.2,
        },
      });
      const raw = (response.text || '').trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`[translateStory] ${modelName}: no JSON array in response:`, raw.slice(0, 200));
        continue;
      }
      const translated: string[] = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(translated) || translated.length !== texts.length) {
        console.warn(`[translateStory] ${modelName}: length mismatch (got ${translated.length}, expected ${texts.length})`);
        continue;
      }
      const result: Record<string, string> = {};
      texts.forEach((original, i) => {
        result[original] = translated[i]?.trim() || original;
      });
      return result;
    } catch (e) {
      console.warn(`[translateStory] ${modelName} failed:`, e);
    }
  }

  console.error('[translateStory] all models failed');
  return {};
}

export async function generateTurn(
  history: string,
  currentPlayer: 'A' | 'B',
  intentText: string,
  currentProgressA: number,
  characterLock: string,
  styleLock: string,
  credibility: number,
  evidenceState: string,
  mediaState: string,
  trustState: string,
  anchors: string[]
): Promise<TurnResult> {
  
  const { textResult, usedTextModel, textError } = await generateTurnText(
    history, currentPlayer, intentText, currentProgressA, characterLock, styleLock, credibility, evidenceState, mediaState, trustState, anchors, false, 99, 'NORMAL'
  );

  const sentences = textResult.sceneText.match(/[^.!?]+[.!?]+/g) || [textResult.sceneText];
  const panelsToGenerate = sentences.slice(0, 4).map((s: string) => s.trim()).filter((s: string) => s.length > 0);
  
  const panels: Panel[] = [];
  let lastImageError: string | null = null;
  let lastImageModel = 'placeholder';

  for (let i = 0; i < panelsToGenerate.length; i++) {
    const sentence = panelsToGenerate[i];
    const imagePrompt = `
      Style: ${styleLock}
      Characters: ${characterLock}
      Context: Continuous scene, panel ${i + 1}.
      Action: ${sentence}
    `;
    
    const { imageUrl, usedImageModel, imageError, imageFailed } = await generateImageOnly(imagePrompt);
    
    panels.push({
      imageUrl: imageFailed ? `https://picsum.photos/seed/${encodeURIComponent(sentence)}/400/300?grayscale` : imageUrl,
      caption: sentence,
      failed: imageFailed
    });

    if (imageError) lastImageError = imageError;
    if (usedImageModel !== 'placeholder') lastImageModel = usedImageModel;
  }

  return {
    sceneText: textResult.sceneText,
    keyframePrompt: textResult.keyframePrompt,
    endingAProgress: textResult.endingAProgress,
    endingBProgress: 100 - textResult.endingAProgress,
    inapplicableIntent: textResult.inapplicableIntent || [],
    inapplicableReason: textResult.inapplicableReason,
    bonusAwarded: textResult.bonusAwarded || false,
    bonusAmount: textResult.bonusAmount || 0,
    credibilityDelta: textResult.credibilityDelta || 0,
    newEvidenceState: textResult.newEvidenceState || evidenceState,
    newMediaState: textResult.newMediaState || mediaState,
    newTrustState: textResult.newTrustState || trustState,
    opponentSummary: textResult.opponentSummary,
    panels,
    debugInfo: {
      textModel: usedTextModel,
      imageModel: lastImageModel,
      lastError: [textError, lastImageError].filter(Boolean).join(' | ') || null,
    }
  };
}
