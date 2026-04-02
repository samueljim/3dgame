import { useEffect, useRef, useState, useCallback } from 'react';
import { gsap } from 'gsap';
import { NeonFallGame } from '../game/NeonFall';
import { SoundManager } from '../game/SoundManager';
import type { LobbyState, ServerMessage } from '@shared/types';
import { DASH_COOLDOWN_MS, MAX_ROUNDS } from '@shared/types';

interface GameCanvasProps {
  lobbyState: LobbyState;
  playerId: string;
  ws: WebSocket;
  onGameOver: () => void;
}

const DASH_MAX_COOLDOWN = DASH_COOLDOWN_MS;

export default function GameCanvas({ lobbyState: initialState, playerId, ws, onGameOver }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<NeonFallGame | null>(null);
  const soundRef = useRef<SoundManager>(new SoundManager());
  const countdownRef = useRef<HTMLDivElement>(null);
  const countdownNumRef = useRef<HTMLDivElement>(null);
  const joystickRef = useRef<HTMLDivElement>(null);
  const joystickThumbRef = useRef<HTMLDivElement>(null);

  const [currentState, setCurrentState] = useState(initialState);
  const [gameOver, setGameOver] = useState(false);
  const [showElimination, setShowElimination] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [countdownVisible, setCountdownVisible] = useState(false);

  const touchState = useRef({
    active: false,
    touchId: -1,
    startX: 0,
    startY: 0,
    dx: 0,
    dy: 0,
  });

  const showCountdownNumber = useCallback((text: string, color: string, duration: number) => {
    const el = countdownNumRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    gsap.fromTo(el,
      { scale: 2, opacity: 1 },
      { scale: 0.5, opacity: 0, duration, ease: 'power2.in' }
    );
  }, []);

  const runCountdown = useCallback((num: number) => {
    setCountdownVisible(true);
    const sound = soundRef.current;
    if (num > 0) {
      sound.init();
      sound.playCountdown(num);
      const countdownColors: Record<number, string> = { 1: '#ff4444', 2: '#ffaa00', 3: '#00ffff' };
      showCountdownNumber(String(num), countdownColors[num] ?? '#00ffff', 0.8);
      if (num > 1) {
        setTimeout(() => runCountdown(num - 1), 1000);
      } else {
        setTimeout(() => {
          sound.playCountdownGo();
          showCountdownNumber('GO!', '#44ff44', 0.5);
          setTimeout(() => setCountdownVisible(false), 600);
        }, 1000);
      }
    } else {
      setCountdownVisible(false);
    }
  }, [showCountdownNumber]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const sound = soundRef.current;

    const game = new NeonFallGame(canvasRef.current, ws, playerId, initialState, sound);
    gameRef.current = game;
    sound.startAmbient();

    const handleMessage = (event: MessageEvent) => {
      const msg: ServerMessage = JSON.parse(event.data);

      if (msg.type === 'game_state') {
        setCurrentState(msg.lobbyState);
        game.updateState(msg.lobbyState);
        if (typeof msg.lobbyState.countdown === 'number' && msg.lobbyState.countdown > 0) {
          runCountdown(msg.lobbyState.countdown);
        }
      } else if (msg.type === 'player_eliminated') {
        const notification = `${msg.playerName} fell off!`;
        setShowElimination(notification);
        game.notifyElimination(msg.playerName);
        setTimeout(() => setShowElimination(''), 3000);
      } else if (msg.type === 'game_over') {
        setCurrentState(msg.lobbyState);
        game.updateState(msg.lobbyState);
        setGameOver(true);
      }
    };

    ws.addEventListener('message', handleMessage);

    return () => {
      ws.removeEventListener('message', handleMessage);
      game.destroy();
      sound.stopAmbient();
    };
  }, []);

  const handleJoystickStart = useCallback((e: React.TouchEvent) => {
    soundRef.current.init();
    const touch = e.changedTouches[0];
    const ts = touchState.current;
    ts.active = true;
    ts.touchId = touch.identifier;
    ts.startX = touch.clientX;
    ts.startY = touch.clientY;
    ts.dx = 0;
    ts.dy = 0;
  }, []);

  const handleJoystickMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const ts = touchState.current;
    if (!ts.active) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === ts.touchId) {
        const dx = touch.clientX - ts.startX;
        const dy = touch.clientY - ts.startY;
        const maxR = 40;
        ts.dx = Math.max(-maxR, Math.min(maxR, dx));
        ts.dy = Math.max(-maxR, Math.min(maxR, dy));

        const thumb = joystickThumbRef.current;
        if (thumb) {
          thumb.style.transform = `translate(${ts.dx}px, ${ts.dy}px)`;
        }

        const game = gameRef.current;
        if (game) {
          const threshold = 10;
          game.setKeys({
            w: ts.dy < -threshold,
            s: ts.dy > threshold,
            a: ts.dx < -threshold,
            d: ts.dx > threshold,
          });
        }
        break;
      }
    }
  }, []);

  const handleJoystickEnd = useCallback((e: React.TouchEvent) => {
    const ts = touchState.current;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === ts.touchId) {
        ts.active = false;
        ts.dx = 0;
        ts.dy = 0;
        const thumb = joystickThumbRef.current;
        if (thumb) thumb.style.transform = 'translate(0px, 0px)';
        gameRef.current?.setKeys({ w: false, s: false, a: false, d: false });
        break;
      }
    }
  }, []);

  const handleDashPress = useCallback(() => {
    soundRef.current.init();
    gameRef.current?.setKeys({ space: true });
  }, []);

  const handleDashRelease = useCallback(() => {
    gameRef.current?.setKeys({ space: false });
  }, []);

  const handleMuteToggle = useCallback(() => {
    soundRef.current.init();
    soundRef.current.toggleMute();
    setIsMuted(soundRef.current.isMuted);
  }, []);

  const handleRestartGame = useCallback(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'restart_game' }));
    }
  }, [ws]);

  const myPlayer = currentState.players.find(p => p.id === playerId);
  const alivePlayers = currentState.players.filter(p => p.isAlive);
  const minutes = Math.floor(currentState.gameTime / 60);
  const seconds = Math.floor(currentState.gameTime % 60);

  const nextFallMs = currentState.nextTileFallIn;
  const fallWarningClass = nextFallMs < 1000 ? 'urgent' : nextFallMs < 2500 ? 'warning' : 'safe';

  const colorDotClass: Record<string, string> = {
    red: 'hud-dot-red',
    green: 'hud-dot-green',
    yellow: 'hud-dot-yellow',
    purple: 'hud-dot-purple',
  };

  const colorTextStyle: Record<string, string> = {
    red: '#ff4444',
    green: '#44ff44',
    yellow: '#ffff44',
    purple: '#aa44ff',
  };

  const winnerPlayer = currentState.winner
    ? currentState.players.find(p => p.id === currentState.winner)
    : null;

  const roundWinnerPlayer = currentState.roundWinnerId
    ? currentState.players.find(p => p.id === currentState.roundWinnerId)
    : null;

  const isRoundOver = currentState.status === 'round_over';
  const maxWins = Math.ceil((currentState.maxRounds ?? MAX_ROUNDS) / 2);

  return (
    <div className="game-wrapper">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* Countdown overlay */}
      {countdownVisible && (
        <div className="countdown-overlay" ref={countdownRef}>
          <div className="countdown-number" ref={countdownNumRef} />
        </div>
      )}

      {/* HUD */}
      <div className="game-hud">
        <div className="hud-players">
          {/* Round indicator */}
          {currentState.currentRound > 0 && (
            <div className="hud-round-badge">
              Round {currentState.currentRound}/{currentState.maxRounds ?? MAX_ROUNDS}
            </div>
          )}
          {currentState.players.map(player => {
            const cooldownPct = player.dashCooldown
              ? Math.max(0, Math.min(1, player.dashCooldown / DASH_MAX_COOLDOWN))
              : 0;
            const playerWins = currentState.roundScores?.[player.id] ?? 0;
            return (
              <div key={player.id} className={`hud-player ${!player.isAlive ? 'eliminated' : ''}`}>
                <div className={`hud-dot ${colorDotClass[player.color]}`} />
                <div className="hud-player-info">
                  <div className="hud-player-name-row">
                    <span>{player.name}</span>
                    {player.id === playerId && <span style={{ color: 'rgba(200,200,255,0.5)', fontSize: '0.7rem' }}>(you)</span>}
                    {currentState.currentRound > 0 && (
                      <span className="hud-wins" title="Round wins">
                        {'★'.repeat(playerWins)}{'☆'.repeat(Math.max(0, maxWins - playerWins))}
                      </span>
                    )}
                  </div>
                  {player.id === playerId && (
                    <div className="hud-dash-bar">
                      <div
                        className="hud-dash-fill"
                        style={{ width: `${(1 - cooldownPct) * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="hud-timer">
          <div className="hud-time">{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</div>
          <div className={`hud-tile-warning ${fallWarningClass}`}>
            {fallWarningClass === 'urgent'
              ? '⚠ TILES FALLING!'
              : fallWarningClass === 'warning'
              ? `Tiles fall in ${(nextFallMs / 1000).toFixed(1)}s`
              : `Next fall: ${(nextFallMs / 1000).toFixed(1)}s`}
          </div>
          <div style={{ fontSize: '0.7rem', marginTop: '0.2rem', color: 'rgba(200,200,255,0.4)' }}>
            {alivePlayers.length} alive
          </div>
        </div>

        <div className="hud-right">
          <button
            className="mute-btn"
            onClick={handleMuteToggle}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
          <div className="hud-controls">
            <div className="controls-title">Controls</div>
            WASD / Arrows - Move<br />
            Space - Dash
          </div>
        </div>
      </div>

      {/* Mobile controls */}
      <div className="mobile-controls">
        <div
          className="joystick-area"
          ref={joystickRef}
          onTouchStart={handleJoystickStart}
          onTouchMove={handleJoystickMove}
          onTouchEnd={handleJoystickEnd}
          onTouchCancel={handleJoystickEnd}
        >
          <div className="joystick-thumb" ref={joystickThumbRef} />
        </div>
        <button
          className="dash-btn"
          onTouchStart={handleDashPress}
          onTouchEnd={handleDashRelease}
          onTouchCancel={handleDashRelease}
        >
          DASH
        </button>
      </div>

      {showElimination && (
        <div className="elimination-toast">💥 {showElimination}</div>
      )}

      {/* Between-rounds overlay */}
      {isRoundOver && !gameOver && (
        <div className="game-overlay round-over-overlay">
          <div className="overlay-title round-over-title">
            {roundWinnerPlayer
              ? `Round ${currentState.currentRound} Over!`
              : `Round ${currentState.currentRound} — Draw!`}
          </div>
          {roundWinnerPlayer && (
            <div className="overlay-winner" style={{ color: colorTextStyle[roundWinnerPlayer.color] ?? '#fff' }}>
              🏅 {roundWinnerPlayer.name} wins the round!
            </div>
          )}
          <div className="round-scores">
            {currentState.players.map(p => {
              const wins = currentState.roundScores?.[p.id] ?? 0;
              return (
                <div key={p.id} className="round-score-row" style={{ color: colorTextStyle[p.color] }}>
                  <span className="round-score-name">{p.name}</span>
                  <span className="round-score-stars">
                    {'★'.repeat(wins)}{'☆'.repeat(Math.max(0, maxWins - wins))}
                  </span>
                  <span className="round-score-count">{wins} win{wins !== 1 ? 's' : ''}</span>
                </div>
              );
            })}
          </div>
          <div className="overlay-subtitle" style={{ marginTop: '1rem' }}>
            Next round starting soon…
          </div>
        </div>
      )}

      {gameOver && (
        <div className="game-overlay">
          <div className="overlay-title">
            {myPlayer?.id === currentState.winner ? '🏆 YOU WIN!' : 'GAME OVER'}
          </div>
          {winnerPlayer ? (
            <div className="overlay-winner" style={{ color: colorTextStyle[winnerPlayer.color] ?? '#fff' }}>
              🥇 {winnerPlayer.name} wins the match!
            </div>
          ) : (
            <div className="overlay-subtitle">Everyone fell off!</div>
          )}
          {/* Final scoreboard */}
          <div className="round-scores">
            {[...currentState.players]
              .sort((a, b) => (currentState.roundScores?.[b.id] ?? 0) - (currentState.roundScores?.[a.id] ?? 0))
              .map(p => {
                const wins = currentState.roundScores?.[p.id] ?? 0;
                return (
                  <div key={p.id} className="round-score-row" style={{ color: colorTextStyle[p.color] }}>
                    <span className="round-score-name">{p.name}</span>
                    <span className="round-score-stars">
                      {'★'.repeat(wins)}{'☆'.repeat(Math.max(0, maxWins - wins))}
                    </span>
                    <span className="round-score-count">{wins} win{wins !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
          </div>
          <div className="overlay-subtitle" style={{ marginTop: '0.5rem' }}>
            Survived: {Math.floor(currentState.gameTime)}s total
          </div>
          <div className="overlay-buttons">
            {myPlayer?.isHost && (
              <button className="btn btn-secondary" onClick={handleRestartGame}>
                🔄 Play Again
              </button>
            )}
            <button className="btn btn-primary" onClick={onGameOver}>
              ← Back to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
