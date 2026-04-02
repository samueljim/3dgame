export type PlayerColor = 'red' | 'green' | 'yellow' | 'purple';

export const PLAYER_COLORS: PlayerColor[] = ['red', 'green', 'yellow', 'purple'];

export interface Player {
  id: string;
  name: string;
  color: PlayerColor;
  isHost: boolean;
  isReady: boolean;
  isAlive: boolean;
  position: { x: number; z: number }; // grid position
  score: number;
  dashCooldown?: number;
}

export interface TileState {
  x: number;
  z: number;
  state: 'solid' | 'crumbling' | 'fallen';
  fallTimer?: number; // ms until fall
}

export type LobbyStatus = 'waiting' | 'playing' | 'round_over' | 'finished';

export interface LobbyState {
  lobbyId: string;
  players: Player[];
  status: LobbyStatus;
  tiles: TileState[][];    // 10x10 grid
  gameTime: number;        // seconds elapsed
  winner: string | null;   // player id (final match winner)
  nextTileFallIn: number;  // ms
  countdown?: number;
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
  | { type: 'input'; keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean } }
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

export const ARENA_SIZE = 10;
export const TILE_SIZE = 2; // world units per tile
export const PLAYER_SPEED = 0.08; // tiles per tick
export const DASH_FORCE = 3.0;
export const TICK_RATE = 50; // ms
export const TILE_FALL_INTERVAL = 7000; // ms between tile falls (starts slower for longer rounds)
export const TILES_PER_FALL = 2;
export const TILE_CRUMBLE_WARNING = 2000;
export const DASH_COOLDOWN_MS = 1200;
export const MAX_ROUNDS = 5; // first to win ceil(MAX_ROUNDS/2) rounds wins the match
