import { useEffect, useRef, useState, useCallback } from 'react';
import { gsap } from 'gsap';
import { TronBikesGame } from '../game/TronBikes';
import { SoundManager } from '../game/SoundManager';
import type { LobbyState, ServerMessage } from '@shared/types';
import { MAX_ROUNDS, SPEED_LEVEL_THRESHOLDS } from '@shared/types';
import musicUrl from './music.mp3';

interface GameCanvasProps {
  lobbyState: LobbyState;
  playerId: string;
  ws: WebSocket;
  onGameOver: () => void;
}

export default function GameCanvas({ lobbyState: initialState, playerId, ws, onGameOver }: GameCanvasProps) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const gameRef     = useRef<TronBikesGame | null>(null);
  const soundRef    = useRef<SoundManager>(new SoundManager());
  const countdownRef    = useRef<HTMLDivElement>(null);
  const countdownNumRef = useRef<HTMLDivElement>(null);
  const joystickRef      = useRef<HTMLDivElement>(null);
  const joystickThumbRef = useRef<HTMLDivElement>(null);

  const [currentState, setCurrentState] = useState(initialState);
  const [gameOver, setGameOver]         = useState(false);
  const [showElimination, setShowElimination] = useState('');
  const [isMuted, setIsMuted]           = useState(false);
  const [countdownVisible, setCountdownVisible] = useState(false);

  const touchState = useRef({
    active: false, touchId: -1, startX: 0, startY: 0, dx: 0, dy: 0,
  });

  const showCountdownNumber = useCallback((text: string, color: string, duration: number) => {
    const el = countdownNumRef.current;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    gsap.fromTo(el,
      { scale: 2, opacity: 1 },
      { scale: 0.5, opacity: 0, duration, ease: 'power2.in' },
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

    const game = new TronBikesGame(canvasRef.current, ws, playerId, initialState, sound);
    gameRef.current = game;
    sound.startAmbient();
    sound.startMusic(musicUrl);

    const handleMessage = (event: MessageEvent) => {
      const msg: ServerMessage = JSON.parse(event.data);
      if (msg.type === 'game_state') {
        setCurrentState(msg.lobbyState);
        game.updateState(msg.lobbyState);
        if (typeof msg.lobbyState.countdown === 'number' && msg.lobbyState.countdown > 0) {
          runCountdown(msg.lobbyState.countdown);
        }
      } else if (msg.type === 'player_eliminated') {
        const notification = `${msg.playerName} crashed!`;
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
      sound.stopMusic();
    };
  }, []);

  // ─── Mobile joystick ──────────────────────────────────────────────────────

  const handleJoystickStart = useCallback((e: React.TouchEvent) => {
    soundRef.current.init();
    const touch = e.changedTouches[0];
    const ts = touchState.current;
    ts.active = true; ts.touchId = touch.identifier;
    ts.startX = touch.clientX; ts.startY = touch.clientY;
    ts.dx = 0; ts.dy = 0;
  }, []);

  const handleJoystickMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const ts = touchState.current;
    if (!ts.active) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier !== ts.touchId) continue;
      const dx = touch.clientX - ts.startX;
      const dy = touch.clientY - ts.startY;
      const maxR = 40;
      ts.dx = Math.max(-maxR, Math.min(maxR, dx));
      ts.dy = Math.max(-maxR, Math.min(maxR, dy));
      const thumb = joystickThumbRef.current;
      if (thumb) thumb.style.transform = `translate(${ts.dx}px, ${ts.dy}px)`;
      const game = gameRef.current;
      if (game) {
        const thr = 12;
        game.setKeys({ w: ts.dy < -thr, s: ts.dy > thr, a: ts.dx < -thr, d: ts.dx > thr });
      }
      break;
    }
  }, []);

  const handleJoystickEnd = useCallback((e: React.TouchEvent) => {
    const ts = touchState.current;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier !== ts.touchId) continue;
      ts.active = false; ts.dx = 0; ts.dy = 0;
      const thumb = joystickThumbRef.current;
      if (thumb) thumb.style.transform = 'translate(0px, 0px)';
      gameRef.current?.setKeys({ w: false, s: false, a: false, d: false });
      break;
    }
  }, []);

  const handleMuteToggle = useCallback(() => {
    soundRef.current.init();
    soundRef.current.toggleMute();
    setIsMuted(soundRef.current.isMuted);
  }, []);

  const handleJumpPress = useCallback(() => {
    soundRef.current.init();
    gameRef.current?.setKeys({ space: true });
  }, []);

  const handleJumpRelease = useCallback(() => {
    gameRef.current?.setKeys({ space: false });
  }, []);

  const handleRestartGame = useCallback(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'restart_game' }));
    }
  }, [ws]);

  // ─── Derived display values ────────────────────────────────────────────────

  const myPlayer = currentState.players.find(p => p.id === playerId);
  const alivePlayers = currentState.players.filter(p => p.isAlive);
  const jumpCharges = myPlayer?.jumpCharges ?? 0;
  const minutes = Math.floor(currentState.gameTime / 60);
  const seconds = Math.floor(currentState.gameTime % 60);

  const speedLevel = currentState.speedLevel ?? 0;
  const speedLabels = ['SLOW', 'NORMAL', 'FAST', '⚡ MAX'];
  const speedColors = ['#44ffee', '#ffee44', '#ff9944', '#ff3333'];
  // seconds until next speed-up (null if already at max)
  const nextSpeedThreshold = SPEED_LEVEL_THRESHOLDS[speedLevel + 1] ?? null;
  const secUntilSpeedup = nextSpeedThreshold !== null
    ? Math.max(0, Math.ceil(nextSpeedThreshold - currentState.gameTime))
    : null;

  const colorDotClass: Record<string, string> = {
    red: 'hud-dot-red', green: 'hud-dot-green', yellow: 'hud-dot-yellow',
    purple: 'hud-dot-purple', blue: 'hud-dot-blue', cyan: 'hud-dot-cyan',
    orange: 'hud-dot-orange', pink: 'hud-dot-pink',
  };

  const colorTextStyle: Record<string, string> = {
    red: '#ff4444', green: '#44ff44', yellow: '#ffff44', purple: '#aa44ff',
    blue: '#4477ff', cyan: '#44ffee', orange: '#ff9944', pink: '#ff44bb',
  };

  const winnerPlayer = currentState.winner
    ? currentState.players.find(p => p.id === currentState.winner) : null;
  const roundWinnerPlayer = currentState.roundWinnerId
    ? currentState.players.find(p => p.id === currentState.roundWinnerId) : null;
  const isRoundOver = currentState.status === 'round_over';
  const STAR_COUNT = Math.ceil(MAX_ROUNDS / 2);

  const dirLabel: Record<string, string> = { N: '↑', S: '↓', E: '→', W: '←' };

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
          {currentState.currentRound > 0 && (
            <div className="hud-round-badge">
              Round {currentState.currentRound}/{currentState.maxRounds ?? MAX_ROUNDS}
            </div>
          )}
          {currentState.players.map(player => {
            const wins = currentState.roundScores?.[player.id] ?? 0;
            return (
              <div key={player.id} className={`hud-player ${!player.isAlive ? 'eliminated' : ''}`}>
                <div className={`hud-dot ${colorDotClass[player.color]}`} />
                <div className="hud-player-info">
                  <div className="hud-player-name-row">
                    <span>{player.name}</span>
                    {player.id === playerId && (
                      <span style={{ color: 'rgba(200,200,255,0.5)', fontSize: '0.7rem' }}>(you)</span>
                    )}
                    {currentState.currentRound > 0 && (
                      <span className="hud-wins" title="Round wins">
                        {Array.from({ length: STAR_COUNT }, (_, i) => i < wins ? '★' : '☆').join('')}
                      </span>
                    )}
                    {player.id === playerId && player.isAlive && (
                      <span style={{ color: colorTextStyle[player.color], fontSize: '0.8rem', marginLeft: '0.3rem' }}>
                        {dirLabel[player.direction] ?? ''}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="hud-timer">
          <div className="hud-time">{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</div>
          {/* Speed level badge */}
          <div style={{
            marginTop: '0.35rem',
            padding: '0.15rem 0.45rem',
            borderRadius: '4px',
            background: 'rgba(0,0,0,0.5)',
            border: `1px solid ${speedColors[speedLevel]}`,
            color: speedColors[speedLevel],
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textAlign: 'center',
          }}>
            {speedLabels[speedLevel]}
            {secUntilSpeedup !== null && secUntilSpeedup > 0 && (
              <span style={{ opacity: 0.65, fontWeight: 400, marginLeft: '0.3rem' }}>
                +{secUntilSpeedup}s
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.7rem', marginTop: '0.3rem', color: 'rgba(200,200,255,0.4)' }}>
            {alivePlayers.length} alive
          </div>
          <div className="hud-jump">
            JUMP {jumpCharges > 0 ? `×${jumpCharges}` : '—'}
          </div>
        </div>

        <div className="hud-right">
          <button className="mute-btn" onClick={handleMuteToggle} title={isMuted ? 'Unmute' : 'Mute'}>
            {isMuted ? '��' : '🔊'}
          </button>
          <div className="hud-controls">
            <div className="controls-title">Controls</div>
            WASD / Arrows — Steer<br />
            Space — Jump (if charged)<br />
            <span style={{ color: 'rgba(255,180,80,0.7)', fontSize: '0.65rem' }}>
              Grab purple pickups for rare jumps.
            </span>
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
        <div className="mobile-action-btns" style={{ minWidth: '70px' }}>
          <button
            className="btn btn-secondary"
            style={{ minWidth: '70px', minHeight: '70px', borderRadius: '50%', padding: 0 }}
            onTouchStart={handleJumpPress}
            onTouchEnd={handleJumpRelease}
            onTouchCancel={handleJumpRelease}
            onMouseDown={handleJumpPress}
            onMouseUp={handleJumpRelease}
            onMouseLeave={handleJumpRelease}
          >
            JUMP
          </button>
        </div>
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
                    {Array.from({ length: STAR_COUNT }, (_, i) => i < wins ? '★' : '☆').join('')}
                  </span>
                  <span className="round-score-count">{wins} win{wins !== 1 ? 's' : ''}</span>
                </div>
              );
            })}
          </div>
          <div className="overlay-subtitle" style={{ marginTop: '1rem' }}>Next round starting soon…</div>
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
            <div className="overlay-subtitle">All bikes crashed!</div>
          )}
          <div className="round-scores">
            {[...currentState.players]
              .sort((a, b) => (currentState.roundScores?.[b.id] ?? 0) - (currentState.roundScores?.[a.id] ?? 0))
              .map(p => {
                const wins = currentState.roundScores?.[p.id] ?? 0;
                return (
                  <div key={p.id} className="round-score-row" style={{ color: colorTextStyle[p.color] }}>
                    <span className="round-score-name">{p.name}</span>
                    <span className="round-score-stars">
                      {Array.from({ length: STAR_COUNT }, (_, i) => i < wins ? '★' : '☆').join('')}
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
              <button className="btn btn-secondary" onClick={handleRestartGame}>🔄 Play Again</button>
            )}
            <button className="btn btn-primary" onClick={onGameOver}>← Back to Lobby</button>
          </div>
        </div>
      )}
    </div>
  );
}
