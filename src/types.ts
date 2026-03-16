import { PlayerId } from './storyPacks';
import { OutcomeFields } from './outcomeEngine';

export interface Panel {
  imageUrl: string;
  caption: string;
  failed?: boolean;
}

export interface TurnData {
  id: string;
  turn: number;
  player: PlayerId | 'System';
  text: string;
  panels?: Panel[];
  inapplicable?: string[];
  inapplicableReason?: string;
  bonus?: boolean;
}

export interface IntentRecord {
  turnIndex: number;
  intentMdText: string;
}

export interface GameState {
  sessionId: string;
  storyId: string;
  playerAName: string;
  playerBName: string;
  currentTurn: number;
  currentPlayer: PlayerId;
  progressA: number;
  credibility: number;
  evidenceState: string;
  mediaState: string;
  trustState: string;
  currentHook: string;
  storyboard: TurnData[];
  lastIntentByPlayer: {
    A?: IntentRecord;
    B?: IntentRecord;
  };
  isGameOver: boolean;
  /** Outcome engine — momentum, streak, phase. Wired in but not yet driving UI. */
  outcome: OutcomeFields;
  /**
   * Tracks whether each player has already earned their side quest bonus this match.
   * Once true, the bonus cannot fire again for that player.
   */
  sideQuestEarned: { A: boolean; B: boolean };
}
