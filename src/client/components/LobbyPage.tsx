import { useEffect, useRef, useState } from 'react';
import type { LobbyState, ClientMessage } from '@shared/types';

interface LobbyPageProps {
  lobbyId: string;
  playerName: string;
  playerId: string;
  lobbyState: LobbyState | null;
  ws: WebSocket | null;
  onConnected: (ws: WebSocket) => void;
  onBack: () => void;
}

export default function LobbyPage({
  lobbyId, playerName, playerId, lobbyState, ws, onConnected, onBack
}: LobbyPageProps) {
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(playerName);
  const wsRef = useRef<WebSocket | null>(null);
  const hasConnected = useRef(false);

  const shareUrl = `${window.location.origin}?lobby=${lobbyId}`;

  useEffect(() => {
    if (hasConnected.current || ws) return;
    hasConnected.current = true;

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/lobby/${lobbyId}`;
    const websocket = new WebSocket(wsUrl);
    wsRef.current = websocket;

    websocket.onopen = () => {
      setConnected(true);
      const joinMsg: ClientMessage = { type: 'join', playerName };
      websocket.send(JSON.stringify(joinMsg));
      onConnected(websocket);
    };

    websocket.onerror = () => {
      setError('Failed to connect to lobby. Please check the lobby code and try again.');
      setConnected(false);
    };

    websocket.onclose = () => {
      setConnected(false);
    };

    return () => {
      // Don't close on unmount if the game is starting
    };
  }, [lobbyId]);

  const handleStartGame = () => {
    if (!ws && !wsRef.current) return;
    const socket = ws || wsRef.current!;
    const msg: ClientMessage = { type: 'start_game' };
    socket.send(JSON.stringify(msg));
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleRenameSubmit = () => {
    const trimmed = newName.trim().substring(0, 16);
    if (!trimmed) return;
    const socket = ws || wsRef.current;
    if (!socket) return;
    const msg: ClientMessage = { type: 'rename', playerName: trimmed };
    socket.send(JSON.stringify(msg));
    setEditingName(false);
  };

  const myPlayer = lobbyState?.players.find(p => p.id === playerId);
  const isHost = myPlayer?.isHost ?? false;
  const canStart = isHost && (lobbyState?.players.length ?? 0) >= 1;

  const playerSlots = Array.from({ length: 8 }, (_, i) => lobbyState?.players[i] ?? null);

  const colorMap: Record<string, string> = {
    red: '#ff4444', green: '#44ff44', yellow: '#ffff44', purple: '#aa44ff',
    blue: '#4477ff', cyan: '#44ffee', orange: '#ff9944', pink: '#ff44bb',
  };

  return (
    <div className="lobby-page">
      <div className="lobby-card">
        <div className="lobby-header">
          <h2 className="lobby-title">LOBBY</h2>
          <div className="lobby-id-badge">{lobbyId}</div>
        </div>

        {error && (
          <div style={{ color: '#ff6666', background: 'rgba(255,0,0,0.1)', border: '1px solid rgba(255,0,0,0.3)', borderRadius: '6px', padding: '0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}

        {!connected && !error && (
          <div className="status-connecting">Connecting</div>
        )}

        {connected && (
          <>
            <div className="share-section">
              <div className="share-label">Share this link with friends</div>
              <div className="share-link">
                <div className="share-url">{shareUrl}</div>
                <button className="btn-copy" onClick={handleCopyLink}>
                  {copied ? '✓ Copied!' : 'Copy'}
                </button>
              </div>
            </div>

            <div className="players-section">
              <div className="section-title">Players ({lobbyState?.players.length ?? 0}/8)</div>
              <div className="players-grid">
                {playerSlots.map((player, i) => (
                  <div key={i} className={`player-slot ${!player ? 'empty' : ''}`}>
                    {player ? (
                      <>
                        <div
                          className="player-color-dot"
                          style={{ background: colorMap[player.color], color: colorMap[player.color] }}
                        />
                        <div className="player-info">
                          {player.id === playerId && editingName ? (
                            <div className="rename-form">
                              <input
                                className="rename-input"
                                type="text"
                                value={newName}
                                onChange={e => setNewName(e.target.value)}
                                maxLength={16}
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleRenameSubmit();
                                  if (e.key === 'Escape') setEditingName(false);
                                }}
                              />
                              <button className="rename-confirm" onClick={handleRenameSubmit} title="Confirm">✓</button>
                              <button className="rename-cancel" onClick={() => setEditingName(false)} title="Cancel">✕</button>
                            </div>
                          ) : (
                            <div className="player-name-row">
                              <div className="player-name">{player.name}</div>
                              {player.id === playerId && (
                                <button
                                  className="rename-btn"
                                  onClick={() => { setNewName(player.name); setEditingName(true); }}
                                  title="Change name"
                                >
                                  ✏️
                                </button>
                              )}
                            </div>
                          )}
                          <div className="player-badges">
                            {player.isHost && <span className="badge badge-host">Host</span>}
                            {player.id === playerId && <span className="badge badge-you">You</span>}
                          </div>
                        </div>
                      </>
                    ) : (
                      <span style={{ color: 'rgba(200,200,255,0.3)', fontSize: '0.85rem' }}>Waiting...</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* How to play / rules */}
            <details className="rules-section">
              <summary className="rules-summary">📖 How to Play</summary>
              <div className="rules-body">
                <p><strong>Goal:</strong> Be the last player standing. Win <strong>3 out of 5 rounds</strong> to win the match.</p>
                <ul>
                  <li>🎮 <strong>Move</strong> with <kbd>WASD</kbd> or arrow keys.</li>
                  <li>⚡ <strong>Dash</strong> with <kbd>Space</kbd> — launches you in your movement direction. Dashing into an opponent sends them flying! (1.2 s cooldown)</li>
                  <li>🟧 <strong>Tiles</strong> turn orange and crumble beneath you — standing on a fallen tile means instant elimination.</li>
                  <li>💥 <strong>Knock</strong> opponents off the edge or onto fallen tiles to eliminate them.</li>
                  <li>⏩ The platform shrinks faster over time — the longer the round goes, the more chaotic it gets!</li>
                  <li>🏆 Scores carry over between rounds. The player with the most round wins after 5 rounds (or first to 3) wins the match.</li>
                </ul>
                <p style={{ opacity: 0.6, fontSize: '0.78rem' }}>💡 Tip: Use the edges of the arena to your advantage — corner opponents near crumbling tiles before dashing!</p>
              </div>
            </details>

            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'rgba(0,255,255,0.03)', borderRadius: '6px', fontSize: '0.8rem', color: 'rgba(200,200,255,0.5)', lineHeight: '1.5' }}>
              {isHost
                ? `You're the host. ${canStart ? 'Start the game when everyone is ready!' : 'Waiting for players to join...'}`
                : 'Waiting for the host to start the game...'}
            </div>

            <div className="lobby-footer">
              <button className="btn btn-danger" onClick={onBack} style={{ flex: '0 0 auto', width: 'auto', minWidth: '100px' }}>
                ← Leave
              </button>
              {isHost && (
                <button
                  className="btn btn-success"
                  onClick={handleStartGame}
                  disabled={!canStart}
                >
                  ▶ Start Game
                </button>
              )}
              {!isHost && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(200,200,255,0.4)', fontSize: '0.85rem' }}>
                  Waiting for host...
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
