import { useEffect, useRef, useState } from 'react';
import { NeonFallGame } from '../game/NeonFall';
import type { LobbyState, ServerMessage } from '@shared/types';

interface GameCanvasProps {
  lobbyState: LobbyState;
  playerId: string;
  ws: WebSocket;
  onGameOver: () => void;
}

export default function GameCanvas({ lobbyState: initialState, playerId, ws, onGameOver }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<NeonFallGame | null>(null);
  const [currentState, setCurrentState] = useState(initialState);
  const [gameOver, setGameOver] = useState(false);
  const [showElimination, setShowElimination] = useState('');

  useEffect(() => {
    if (!canvasRef.current) return;

    const game = new NeonFallGame(canvasRef.current, ws, playerId, initialState);
    gameRef.current = game;

    const handleMessage = (event: MessageEvent) => {
      const msg: ServerMessage = JSON.parse(event.data);

      if (msg.type === 'game_state') {
        setCurrentState(msg.lobbyState);
        game.updateState(msg.lobbyState);
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
    };
  }, []);

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

  return (
    <div className="game-wrapper">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* HUD */}
      <div className="game-hud">
        <div className="hud-players">
          {currentState.players.map(player => (
            <div key={player.id} className={`hud-player ${!player.isAlive ? 'eliminated' : ''}`}>
              <div className={`hud-dot ${colorDotClass[player.color]}`} />
              <span>{player.name}</span>
              {player.id === playerId && <span style={{ color: 'rgba(200,200,255,0.5)', fontSize: '0.7rem' }}>(you)</span>}
            </div>
          ))}
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

        <div className="hud-controls">
          <div className="controls-title">Controls</div>
          WASD / Arrows - Move<br />
          Space - Dash
        </div>
      </div>

      {showElimination && (
        <div className="elimination-toast">💥 {showElimination}</div>
      )}

      {gameOver && (
        <div className="game-overlay">
          <div className="overlay-title">
            {myPlayer?.id === currentState.winner ? '🏆 YOU WIN!' : 'GAME OVER'}
          </div>
          {winnerPlayer ? (
            <div className="overlay-winner" style={{ color: colorTextStyle[winnerPlayer.color] ?? '#fff' }}>
              🥇 {winnerPlayer.name} wins!
            </div>
          ) : (
            <div className="overlay-subtitle">Everyone fell off!</div>
          )}
          <div className="overlay-subtitle">
            Survived: {Math.floor(currentState.gameTime)}s
          </div>
          <div className="overlay-buttons">
            <button className="btn btn-primary" onClick={onGameOver}>
              ← Back to Lobby
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
