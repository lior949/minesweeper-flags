// App.jsx
import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin";
import "./App.css";

const socket = io("https://minesweeper-flags-backend.onrender.com");

function App() {
  // Lobby & auth
  const [name, setName] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [playersList, setPlayersList] = useState([]);

  // Game
  const [gameId, setGameId] = useState(null);
  const [playerNumber, setPlayerNumber] = useState(null);
  const [board, setBoard] = useState([]);
  const [turn, setTurn] = useState(null);
  const [scores, setScores] = useState({ 1: 0, 2: 0 });
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false });
  const [bombMode, setBombMode] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [opponentName, setOpponentName] = useState("");
  const [invite, setInvite] = useState(null);

  // Join lobby
  const joinLobby = () => {
    if (!name.trim()) return;
    socket.emit("join-lobby", name.trim());
  };

  useEffect(() => {
    socket.on("join-error", (msg) => {
      alert(msg);
    });

    socket.on("lobby-joined", () => {
      setLoggedIn(true);
    });

    socket.on("players-list", (players) => {
      setPlayersList(players);
    });

    socket.on("game-invite", (inviteData) => {
      setInvite(inviteData);
    });

    socket.on("invite-rejected", ({ fromName }) => {
      alert(`${fromName} rejected your invitation.`);
    });

    socket.on("game-start", (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      setBoard(data.board);
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
    });

    socket.on("board-update", (game) => {
      setBoard(game.board);
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false);
    });

    socket.on("wait-bomb-center", () => {
      setBombMode(true);
    });

    socket.on("opponent-left", () => {
      alert("Opponent left the game. Returning to lobby.");
      setGameId(null);
      setPlayerNumber(null);
      setBoard([]);
      setTurn(null);
      setScores({ 1: 0, 2: 0 });
      setBombsUsed({ 1: false, 2: false });
      setGameOver(false);
      setOpponentName("");
      setBombMode(false);
      // Refresh lobby players list will be automatic on server disconnect update
    });

    return () => {
      socket.off("join-error");
      socket.off("lobby-joined");
      socket.off("players-list");
      socket.off("game-invite");
      socket.off("invite-rejected");
      socket.off("game-start");
      socket.off("board-update");
      socket.off("wait-bomb-center");
      socket.off("opponent-left");
    };
  }, []);

  const invitePlayer = (id) => {
    if (loggedIn && id !== socket.id) {
      socket.emit("invite-player", id);
      alert("Invitation sent.");
    }
  };

  const respondInvite = (accept) => {
    if (invite) {
      socket.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null);
    }
  };

  const handleClick = (x, y) => {
    if (!gameId) return;
    if (bombMode) {
      socket.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      socket.emit("tile-click", { gameId, x, y });
    }
  };

  const useBomb = () => {
  if (bombMode) {
    // Cancel bomb mode
    setBombMode(false);
  } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
    socket.emit("use-bomb", { gameId });
  }
};

  // --- NEW/MODIFIED FUNCTION ---
  const backToLobby = () => {
    // Before resetting client-side state, tell the server you're leaving the game.
    // Only emit if you were actually in a game
    if (gameId) {
        socket.emit("leave-game", { gameId });
    }

    // Reset all game-related state on the client
    setGameId(null);
    setPlayerNumber(null);
    setBoard([]);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setBombMode(false);
    setGameOver(false);
    setOpponentName("");
    setInvite(null); // Clear any pending invites in case they were active
};

  const logout = async () => {
  try {
    await fetch("https://minesweeper-flags-frontend.onrender.com/logout", {
      method: "GET",
      credentials: "include", // Important for cookies
    });

    // Reset all state
    setLoggedIn(false);
    setName("");
    setGameId(null);
    setPlayerNumber(null);
    setBoard([]);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setBombMode(false);
    setGameOver(false);
    setOpponentName("");
    setInvite(null);
	window.location.reload();
  } catch (err) {
    console.error("Logout failed", err);
    alert("Logout failed. Please try again.");
  }
};

  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: "red" }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: "blue" }}>🏴</span>;
      return "";
    }
    return tile.adjacentMines > 0 ? tile.adjacentMines : "";
  };

  if (!loggedIn) {
  return (
    <div className="lobby">
      <h2>Login with Google to join the lobby</h2>
      <GoogleLogin
        onLogin={(googleName) => {
          setName(googleName);
          socket.emit("join-lobby", googleName);
        }}
      />
    </div>
  );
}

  if (!gameId) {
    return (
      <div className="lobby">
        <h2>Lobby - Online Players</h2>
		<button onClick={logout} className="bomb-button">Logout</button>
        {playersList.length === 0 && <p>No other players online</p>}
        <ul className="player-list">
          {playersList.map((p) => (
            <li
              key={p.id}
              className="player-item"
              onDoubleClick={() => invitePlayer(p.id)}
              title="Double-click to invite"
            >
              {p.name}
            </li>
          ))}
        </ul>
        {invite && (
          <div className="invite-popup">
            <p>
              Invitation from <b>{invite.fromName}</b>
            </p>
            <button onClick={() => respondInvite(true)}>Accept</button>
            <button onClick={() => respondInvite(false)}>Reject</button>
          </div>
        )}
      </div>
    );
  }

  // In game UI
  return (
    <div className="app">
      <div className="header">
        <h1>Minesweeper Flags</h1>
        {playerNumber &&
          !bombsUsed[playerNumber] &&
          scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] &&
          !gameOver && (
            <button className="bomb-button" onClick={useBomb}>
				{bombMode ? "Cancel Bomb" : "Use Bomb"}
			</button>
          )}
      </div>

      <h2>
        You are Player {playerNumber} (vs. {opponentName})
      </h2>
      <p>
        {turn && !gameOver ? `Current turn: Player ${turn}` : ""}
        {bombMode && " – Select 5x5 bomb center"}
      </p>
      <p>
        Score 🔴 {scores[1]} | 🔵 {scores[2]}
      </p>

      {/* --- MODIFIED BUTTON RENDERING --- */}
      {gameOver && ( // Only show "Back to Lobby" if the game is over
        <button className="bomb-button" onClick={backToLobby}>
          Back to Lobby
        </button>
      )}

      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
        }}
      >
        {board.flatMap((row, y) =>
          row.map((tile, x) => (
            <div
              key={`${x}-${y}`}
              className={`tile ${
                tile.revealed ? "revealed" : "hidden"
              } ${tile.isMine && tile.revealed ? "mine" : ""}`}
              onClick={() => handleClick(x, y)}
            >
              {renderTile(tile)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default App;
