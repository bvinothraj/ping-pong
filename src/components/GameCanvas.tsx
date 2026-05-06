import { useEffect, useRef, useState } from "react";
import { Game, type ScoreSnapshot } from "../game/Game";

const WIN_SCORE = 11;

const initial: ScoreSnapshot = {
  player: 0,
  ai: 0,
  state: "idle",
  message: "Click to serve",
  winner: null,
  muted: false,
};

export default function GameCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  const [snapshot, setSnapshot] = useState<ScoreSnapshot>(initial);
  const [flash, setFlash] = useState<"player" | "ai" | null>(null);
  const prevScores = useRef({ player: 0, ai: 0 });

  useEffect(() => {
    if (snapshot.player > prevScores.current.player) {
      setFlash("player");
      const t = setTimeout(() => setFlash(null), 600);
      prevScores.current.player = snapshot.player;
      prevScores.current.ai = snapshot.ai;
      return () => clearTimeout(t);
    }
    if (snapshot.ai > prevScores.current.ai) {
      setFlash("ai");
      const t = setTimeout(() => setFlash(null), 600);
      prevScores.current.player = snapshot.player;
      prevScores.current.ai = snapshot.ai;
      return () => clearTimeout(t);
    }
    prevScores.current.player = snapshot.player;
    prevScores.current.ai = snapshot.ai;
  }, [snapshot.player, snapshot.ai]);

  useEffect(() => {
    if (!containerRef.current) return;
    const game = new Game(containerRef.current, setSnapshot);
    gameRef.current = game;
    return () => {
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  const showCenterMessage =
    snapshot.state !== "playing" && snapshot.state !== "gameOver" && !!snapshot.message;

  return (
    <div ref={containerRef} className="game-shell">
      <div className="hud">
        <div className="scoreboard">
          <div className={`score ${flash === "player" ? "flash" : ""}`}>
            <span className="score-label">You</span>
            <span className="score-value player">{snapshot.player}</span>
          </div>
          <div className="score-divider">
            <span className="score-target">First to {WIN_SCORE} WINS</span>
          </div>
          <div className={`score ${flash === "ai" ? "flash" : ""}`}>
            <span className="score-label">CPU</span>
            <span className="score-value ai">{snapshot.ai}</span>
          </div>
        </div>

        <button
          className="mute-btn"
          onClick={() => gameRef.current?.toggleMute()}
          aria-label={snapshot.muted ? "Unmute" : "Mute"}
          title={snapshot.muted ? "Unmute" : "Mute"}
        >
          {snapshot.muted ? "Sound: Off" : "Sound: On"}
        </button>

        {showCenterMessage && (
          <div className="center-message">
            {snapshot.message}
            <span className="hint">Move with mouse · click to serve</span>
          </div>
        )}

        {snapshot.state === "gameOver" && (
          <div className="game-over-overlay">
            <h1>{snapshot.winner === "player" ? "You win!" : "AI wins"}</h1>
            <p>
              {snapshot.player} – {snapshot.ai}
            </p>
            <button onClick={() => gameRef.current?.restart()}>Play again</button>
          </div>
        )}
      </div>
    </div>
  );
}
