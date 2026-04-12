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
  /** Bike position in world coordinates (continuous floats, not grid cells). */
  position: { x: number; z: number };
  direction: Direction;
  /** Start of the currently-growing trail segment (world coords). Updated on each turn. */
  trailStart: { x: number; z: number };
  jumpCharges: number;
  isJumping: boolean;
  boostCharges: number;
  isBoosting: boolean;
  score: number;
}

export type LobbyStatus = 'waiting' | 'playing' | 'round_over' | 'finished';

/**
 * A frozen (completed) trail segment left behind by a bike.
 * The currently-growing segment per player is derived from
 * player.trailStart → player.position.
 */
export interface TrailSegment {
  id: string;
  playerId: string;
  colorIndex: number; // 0-based index into PLAYER_COLORS
  x1: number; z1: number; // segment start
  x2: number; z2: number; // segment end
}

export interface LobbyState {
  lobbyId: string;
  players: Player[];
  status: LobbyStatus;
  /** Completed trail segments for all players. */
  trailSegments: TrailSegment[];
  gameTime: number;
  winner: string | null;
  countdown?: number;
  speedLevel: number;
  currentRound: number;
  maxRounds: number;
  roundScores: Record<string, number>;
  roundWinnerId: string | null;
  powerUps: PowerUp[];
}

export type PowerUpType = 'jump' | 'boost';

export interface PowerUp {
  id: string;
  type: PowerUpType;
  position: { x: number; z: number }; // world coordinates
}

export interface InputKeys {
  left: boolean;
  right: boolean;
  space: boolean;
  shift: boolean;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'join'; playerName: string }
  | { type: 'rename'; playerName: string }
  | { type: 'start_game' }
  | { type: 'restart_game' }
  | { type: 'input'; keys: InputKeys }
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

/** Side length of the arena in world units. */
export const ARENA_WORLD_SIZE = 120;

export const TICK_RATE = 50;   // ms per server game-loop tick
export const MAX_ROUNDS = 5;
export const MAX_PLAYERS = 8;

/** Bike speed in world units per second, per speed level (0–3). */
export const BIKE_SPEEDS = [16, 22, 30, 42] as const;

/** Collision radius of each bike in world units. */
export const BIKE_RADIUS = 0.28;

/**
 * Minimum length (world units) of the own active segment before self-collision
 * is tested on it. Prevents instant self-crash right after a turn.
 */
export const TRAIL_SELF_GRACE = 3.0;

/** Duration (seconds) of jump invincibility per charge. */
export const JUMP_DURATION = 0.45;

/** Speed multiplier while boost is active. */
export const BOOST_SPEED_MULT = 1.8;

/** Boost charge drain rate (charges per second while Shift is held). */
export const BOOST_DRAIN_RATE = 0.65;

/** Game-time thresholds (seconds) at which speed advances to the next level. */
export const SPEED_LEVEL_THRESHOLDS = [0, 20, 45, 75] as const;
