export type PlayerColor = 'red' | 'green' | 'yellow' | 'purple' | 'blue' | 'cyan' | 'orange' | 'pink';

export const PLAYER_COLORS: PlayerColor[] = ['red', 'green', 'yellow', 'purple', 'blue', 'cyan', 'orange', 'pink'];

/** Cardinal direction the bike is heading. */
export type Direction = 'N' | 'S' | 'E' | 'W';

export interface Player {
  id: string;
  name: string;
  color: PlayerColor;
  isHost: boolean;
  isReady: boolean;
  isAlive: boolean;
  position: { x: number; z: number }; // grid cell position
  direction: Direction;
  score: number;
}

export type LobbyStatus = 'waiting' | 'playing' | 'round_over' | 'finished';

export interface LobbyState {
  lobbyId: string;
  players: Player[];
  status: LobbyStatus;
  /**
   * trail[x][z]:
   *   0  = empty cell
   *   1–8 = PLAYER_COLORS index + 1 of the bike whose wall occupies this cell
   */
  trail: number[][];
  gameTime: number;      // seconds elapsed
  winner: string | null; // player id (final match winner)
  countdown?: number;
  speedLevel: number;    // 0–3, increases over time; drives bike move frequency
  // multi-round fields
  currentRound: number;
  maxRounds: number;
  roundScores: Record<string, number>; // playerId -> round wins
  roundWinnerId: string | null;        // winner of the most recent round
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'join'; playerName: string }
  | { type: 'rename'; playerName: string }
  | { type: 'start_game' }
  | { type: 'restart_game' }
  | { type: 'input'; keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean } }
  | { type: 'ping' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'joined'; playerId: string; lobbyState: LobbyState }
  | { type: 'lobby_update'; lobbyState: LobbyState }
  | { type: 'game_state'; lobbyState: LobbyState }
  | { type: 'player_eliminated'; playerId: string; playerName: string }
  | { type: 'game_over'; winner: Player | null; lobbyState: LobbyState }
  | { type: 'player_renamed'; playerId: string; playerName: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export const ARENA_SIZE = 40;          // grid cells per side
export const CELL_SIZE = 1.5;          // world units per grid cell
export const TICK_RATE = 50;           // ms per game-loop tick
export const MAX_ROUNDS = 5;           // first to win ceil(MAX_ROUNDS/2) rounds wins the match
export const MAX_PLAYERS = 8;

/**
 * Speed schedule: bikes advance once every SPEED_MOVE_TICKS[level] ticks.
 * Level 0 = slowest (start), level 3 = fastest (endgame).
 * At TICK_RATE = 50ms: level0 = 200ms/move, level1 = 150ms, level2 = 100ms, level3 = 50ms.
 */
export const SPEED_MOVE_TICKS = [4, 3, 2, 1] as const;

/** Game-time thresholds (seconds) at which the speed advances to the next level. */
export const SPEED_LEVEL_THRESHOLDS = [0, 20, 45, 75] as const;
