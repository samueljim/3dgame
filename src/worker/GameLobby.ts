import type {
  LobbyState, Player, ClientMessage, ServerMessage,
  PlayerColor, Direction,
} from '../shared/types';
import {
  PLAYER_COLORS, ARENA_SIZE, TICK_RATE,
  SPEED_MOVE_TICKS, SPEED_LEVEL_THRESHOLDS,
  MAX_ROUNDS, MAX_PLAYERS,
} from '../shared/types';

// Opposite directions — used to prevent immediate reversals
const DIRECTION_OPPOSITES: Record<Direction, Direction> = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Start positions & facing directions for up to 8 players
const START_CONFIGS: Array<{ x: number; z: number; dir: Direction }> = [
  { x: 2,  z: 20, dir: 'E' },
  { x: 37, z: 20, dir: 'W' },
  { x: 20, z: 2,  dir: 'S' },
  { x: 20, z: 37, dir: 'N' },
  { x: 2,  z: 8,  dir: 'E' },
  { x: 37, z: 8,  dir: 'W' },
  { x: 2,  z: 31, dir: 'E' },
  { x: 37, z: 31, dir: 'W' },
];

interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  colorIndex: number; // 0-based index into PLAYER_COLORS; stored as colorIndex+1 in the trail array
  keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; shift: boolean };
  /** Buffered next turn — set immediately when a direction key is received so quick
   *  taps between move ticks are never lost. Consumed on the next move tick. */
  pendingDirection: Direction | null;
}

export class GameLobby {
  private state: DurableObjectState;
  private sessions: Map<string, PlayerSession> = new Map();
  private lobbyState: LobbyState;
  private gameInterval: ReturnType<typeof setInterval> | null = null;
  private lobbyId: string = '';
  private countdownTimeouts: ReturnType<typeof setTimeout>[] = [];
  private moveTickCounter = 0;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.lobbyState = this.createInitialLobbyState();
  }

  private createInitialLobbyState(): LobbyState {
    return {
      lobbyId: this.lobbyId,
      players: [],
      status: 'waiting',
      trail: this.initTrail(),
      gameTime: 0,
      winner: null,
      speedLevel: 0,
      currentRound: 0,
      maxRounds: MAX_ROUNDS,
      roundScores: {},
      roundWinnerId: null,
    };
  }

  private initTrail(): number[][] {
    return Array.from({ length: ARENA_SIZE }, () => new Array<number>(ARENA_SIZE).fill(0));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lobbyId = url.searchParams.get('lobbyId') || this.lobbyId;
    this.lobbyState.lobbyId = this.lobbyId;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleWebSocket(server as WebSocket);

    return new Response(null, { status: 101, webSocket: client as WebSocket });
  }

  private handleWebSocket(ws: WebSocket): void {
    ws.accept();
    const playerId = crypto.randomUUID();

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const msg: ClientMessage = JSON.parse(event.data as string);
        this.handleMessage(ws, playerId, msg);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    ws.addEventListener('close', () => this.handleDisconnect(playerId));
    ws.addEventListener('error', () => this.handleDisconnect(playerId));
  }

  private handleMessage(ws: WebSocket, playerId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join':        this.handleJoin(ws, playerId, msg.playerName); break;
      case 'rename':      this.handleRename(playerId, msg.playerName); break;
      case 'start_game':  this.handleStartGame(playerId); break;
      case 'restart_game': this.handleRestartGame(playerId); break;
      case 'input':       this.handleInput(playerId, msg.keys); break;
      case 'ping':        this.send(ws, { type: 'pong' }); break;
    }
  }

  private handleJoin(ws: WebSocket, playerId: string, playerName: string): void {
    if (this.lobbyState.status === 'playing') {
      this.send(ws, { type: 'error', message: 'Game already in progress' });
      return;
    }
    if (this.lobbyState.players.length >= MAX_PLAYERS) {
      this.send(ws, { type: 'error', message: 'Lobby is full' });
      return;
    }

    const colorIndex = this.lobbyState.players.length;
    const color: PlayerColor = PLAYER_COLORS[colorIndex];
    const cfg = START_CONFIGS[colorIndex];

    const player: Player = {
      id: playerId,
      name: playerName.trim().substring(0, 16) || `Player ${colorIndex + 1}`,
      color,
      isHost: this.lobbyState.players.length === 0,
      isReady: false,
      isAlive: true,
      position: { x: cfg.x, z: cfg.z },
      direction: cfg.dir,
      score: 0,
    };

    this.lobbyState.players.push(player);
    this.sessions.set(playerId, {
      ws, playerId, colorIndex,
      keys: { w: false, a: false, s: false, d: false, space: false, shift: false },
      pendingDirection: null,
    });

    this.send(ws, { type: 'joined', playerId, lobbyState: this.lobbyState });
    this.broadcast({ type: 'lobby_update', lobbyState: this.lobbyState }, playerId);
  }

  private handleRename(playerId: string, playerName: string): void {
    if (this.lobbyState.status !== 'waiting') return;
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player) return;
    const newName = playerName.trim().substring(0, 16) || player.name;
    player.name = newName;
    this.broadcastAll({ type: 'player_renamed', playerId, playerName: newName });
    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private handleStartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.players.length < 1) return;
    if (this.lobbyState.status !== 'waiting') return;

    const roundScores: Record<string, number> = {};
    this.lobbyState.players.forEach(p => { roundScores[p.id] = 0; });
    this.lobbyState.roundScores = roundScores;
    this.lobbyState.currentRound = 1;
    this.lobbyState.roundWinnerId = null;
    this.lobbyState.winner = null;

    this.startRound();
  }

  private startRound(): void {
    this.lobbyState.status = 'playing';
    this.lobbyState.trail = this.initTrail();
    this.lobbyState.gameTime = 0;
    this.lobbyState.speedLevel = 0;
    this.moveTickCounter = 0;

    // Reset player positions and directions
    this.lobbyState.players.forEach((p, i) => {
      const cfg = START_CONFIGS[i];
      p.isAlive = true;
      p.position = { x: cfg.x, z: cfg.z };
      p.direction = cfg.dir;
    });

    // Countdown: 3 → 2 → 1 → GO
    for (const t of this.countdownTimeouts) clearTimeout(t);
    this.countdownTimeouts = [];

    this.lobbyState.countdown = 3;
    this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });

    const t1 = setTimeout(() => {
      this.lobbyState.countdown = 2;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, 1000);

    const t2 = setTimeout(() => {
      this.lobbyState.countdown = 1;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, 2000);

    const t3 = setTimeout(() => {
      this.lobbyState.countdown = 0;
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
      this.startGameLoop();
    }, 3000);

    this.countdownTimeouts.push(t1, t2, t3);
  }

  private startGameLoop(): void {
    let lastTick = Date.now();

    this.gameInterval = setInterval(() => {
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;

      this.lobbyState.gameTime += dt / 1000;

      // Advance speed level based on elapsed time
      let newLevel = 0;
      for (let i = SPEED_LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
        if (this.lobbyState.gameTime >= SPEED_LEVEL_THRESHOLDS[i]) {
          newLevel = i;
          break;
        }
      }
      this.lobbyState.speedLevel = newLevel;
      const moveTicks = SPEED_MOVE_TICKS[newLevel];

      this.moveTickCounter++;

      if (this.moveTickCounter >= moveTicks) {
        this.moveTickCounter = 0;
        this.advanceBikes();
      }

      // Check win condition
      const alivePlayers = this.lobbyState.players.filter(p => p.isAlive);
      // Safety check: if advanceBikes() somehow left ≤1 alive player without ending the round
      // (e.g. via disconnect), catch it here.  moveTickCounter === 0 ensures we only act
      // immediately after a move tick, keeping game state consistent.
      if (alivePlayers.length <= 1 && this.moveTickCounter === 0) {
        this.endRound(alivePlayers[0] ?? null);
        return;
      }

      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });
    }, TICK_RATE);
  }

  private advanceBikes(): void {
    // 1. Determine the direction each alive player wants to move
    const desiredDirs = new Map<string, Direction>();
    for (const [playerId, session] of this.sessions) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (!player || !player.isAlive) continue;
      desiredDirs.set(playerId, this.resolveDirection(session, player.direction));
    }

    // 2. Compute next positions & detect boundary / trail collisions
    const nextPos = new Map<string, { x: number; z: number }>();
    const toEliminate = new Set<string>();

    for (const [playerId, dir] of desiredDirs) {
      const player = this.lobbyState.players.find(p => p.id === playerId)!;
      const { x, z } = player.position;
      let nx = x, nz = z;
      switch (dir) {
        case 'N': nz -= 1; break;
        case 'S': nz += 1; break;
        case 'E': nx += 1; break;
        case 'W': nx -= 1; break;
      }

      // Out-of-bounds → eliminate
      if (nx < 0 || nx >= ARENA_SIZE || nz < 0 || nz >= ARENA_SIZE) {
        toEliminate.add(playerId);
        continue;
      }

      // Trail / occupied cell → eliminate
      if (this.lobbyState.trail[nx][nz] !== 0) {
        toEliminate.add(playerId);
        continue;
      }

      nextPos.set(playerId, { x: nx, z: nz });
    }

    // 3. Head-on collision: two bikes targeting the same empty cell
    const cellTargets = new Map<string, string[]>();
    for (const [id, pos] of nextPos) {
      const key = `${pos.x},${pos.z}`;
      if (!cellTargets.has(key)) cellTargets.set(key, []);
      cellTargets.get(key)!.push(id);
    }
    for (const [, ids] of cellTargets) {
      if (ids.length > 1) {
        ids.forEach(id => toEliminate.add(id));
      }
    }
    for (const id of toEliminate) nextPos.delete(id);

    // 4. Stamp old positions as trail, update positions & directions
    for (const [playerId, pos] of nextPos) {
      const player = this.lobbyState.players.find(p => p.id === playerId)!;
      const session = this.sessions.get(playerId)!;
      // Leave a wall at the cell the bike is vacating
      this.lobbyState.trail[player.position.x][player.position.z] = session.colorIndex + 1;
      player.position = pos;
      player.direction = desiredDirs.get(playerId)!;
    }

    // 5. Eliminate crashed bikes (also mark their final cell)
    for (const playerId of toEliminate) {
      const player = this.lobbyState.players.find(p => p.id === playerId);
      if (player && player.isAlive) {
        player.isAlive = false;
        // Mark their last cell so it's visually blocked
        const session = this.sessions.get(playerId);
        if (session) {
          this.lobbyState.trail[player.position.x][player.position.z] = session.colorIndex + 1;
        }
        this.broadcastAll({ type: 'player_eliminated', playerId, playerName: player.name });
      }
    }

    // 6. Re-check win condition right after advance
    const alive = this.lobbyState.players.filter(p => p.isAlive);
    if (alive.length <= 1) {
      if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
      this.endRound(alive[0] ?? null);
    }
  }

  private resolveDirection(
    session: PlayerSession,
    currentDir: Direction,
  ): Direction {
    // Consume buffered turn first (set by handleInput immediately on key press)
    if (session.pendingDirection !== null && session.pendingDirection !== DIRECTION_OPPOSITES[currentDir]) {
      const dir = session.pendingDirection;
      session.pendingDirection = null;
      return dir;
    }
    // Fall back to current held key state
    // Key priority (highest first): W→North, D→East, A→West, S→South.
    // When multiple keys are held the first non-reversing direction wins.
    const candidates: [boolean, Direction][] = [
      [session.keys.w, 'N'],
      [session.keys.d, 'E'],
      [session.keys.a, 'W'],
      [session.keys.s, 'S'],
    ];
    for (const [held, dir] of candidates) {
      if (held && dir !== DIRECTION_OPPOSITES[currentDir]) return dir;
    }
    return currentDir;
  }

  private endRound(roundWinner: Player | null): void {
    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }

    if (roundWinner) {
      this.lobbyState.roundScores[roundWinner.id] =
        (this.lobbyState.roundScores[roundWinner.id] ?? 0) + 1;
      this.lobbyState.roundWinnerId = roundWinner.id;
    } else {
      this.lobbyState.roundWinnerId = null;
    }

    const maxWins = Math.ceil(this.lobbyState.maxRounds / 2);
    const someoneWonMatch = roundWinner &&
      (this.lobbyState.roundScores[roundWinner.id] ?? 0) >= maxWins;
    const allRoundsPlayed = this.lobbyState.currentRound >= this.lobbyState.maxRounds;

    if (someoneWonMatch || allRoundsPlayed) {
      let matchWinner: Player | null = null;
      let topWins = -1;
      for (const p of this.lobbyState.players) {
        const wins = this.lobbyState.roundScores[p.id] ?? 0;
        if (wins > topWins) { topWins = wins; matchWinner = p; }
      }
      this.lobbyState.winner = matchWinner?.id ?? null;
      this.lobbyState.status = 'finished';
      this.broadcastAll({ type: 'game_over', winner: matchWinner || null, lobbyState: this.lobbyState });
    } else {
      this.lobbyState.status = 'round_over';
      this.broadcastAll({ type: 'game_state', lobbyState: this.lobbyState });

      const nextRoundTimeout = setTimeout(() => {
        this.lobbyState.currentRound += 1;
        this.startRound();
      }, 4000);
      this.countdownTimeouts.push(nextRoundTimeout);
    }
  }

  private handleRestartGame(playerId: string): void {
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (!player?.isHost) return;
    if (this.lobbyState.status !== 'finished') return;

    if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
    for (const t of this.countdownTimeouts) clearTimeout(t);
    this.countdownTimeouts = [];

    this.lobbyState.status = 'waiting';
    this.lobbyState.trail = this.initTrail();
    this.lobbyState.gameTime = 0;
    this.lobbyState.winner = null;
    this.lobbyState.countdown = undefined;
    this.lobbyState.speedLevel = 0;
    this.lobbyState.currentRound = 0;
    this.lobbyState.roundScores = {};
    this.lobbyState.roundWinnerId = null;
    this.moveTickCounter = 0;

    this.lobbyState.players.forEach((p, i) => {
      const cfg = START_CONFIGS[i];
      p.isAlive = true;
      p.score = 0;
      p.position = { x: cfg.x, z: cfg.z };
      p.direction = cfg.dir;
    });

    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private handleInput(playerId: string, keys: PlayerSession['keys']): void {
    const session = this.sessions.get(playerId);
    if (!session) return;

    // Detect which direction the new key state wants and buffer it immediately.
    // This ensures a quick tap between move ticks is never lost.
    const player = this.lobbyState.players.find(p => p.id === playerId);
    if (player && player.isAlive) {
      const candidates: [boolean, Direction][] = [
        [keys.w, 'N'],
        [keys.d, 'E'],
        [keys.a, 'W'],
        [keys.s, 'S'],
      ];
      for (const [held, dir] of candidates) {
        if (held && dir !== player.direction && dir !== DIRECTION_OPPOSITES[player.direction]) {
          // Only overwrite the buffer if this is a genuinely new turn request
          session.pendingDirection = dir;
          break;
        }
      }
    }

    session.keys = keys;
  }

  private handleDisconnect(playerId: string): void {
    this.sessions.delete(playerId);
    const idx = this.lobbyState.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;

    this.lobbyState.players.splice(idx, 1);

    // Promote new host if needed
    if (this.lobbyState.players.length > 0 && !this.lobbyState.players.some(p => p.isHost)) {
      this.lobbyState.players[0].isHost = true;
    }

    // If only one player left during play, end round
    if (this.lobbyState.status === 'playing') {
      const alive = this.lobbyState.players.filter(p => p.isAlive);
      if (alive.length <= 1) {
        if (this.gameInterval) { clearInterval(this.gameInterval); this.gameInterval = null; }
        this.endRound(alive[0] ?? null);
        return;
      }
    }

    this.broadcastAll({ type: 'lobby_update', lobbyState: this.lobbyState });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* connection already closed */ }
  }

  private broadcast(msg: ServerMessage, excludeId?: string): void {
    for (const session of this.sessions.values()) {
      if (session.playerId !== excludeId) this.send(session.ws, msg);
    }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const session of this.sessions.values()) this.send(session.ws, msg);
  }
}
