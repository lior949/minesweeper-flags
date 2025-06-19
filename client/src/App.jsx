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
  const [bombError, setBombError] = useState(""); // New state for bomb errors

  // Join lobby
  const joinLobby = () => {
    if (!name.trim()) return;
    socket.emit("join-lobby", name.trim());
  };

  useEffect(() => {
    // Initial Authentication Check (from previous version)
    const checkAuthStatus = async () => {
        try {
            const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
                method: "GET",
                credentials: "include",
            });
            if (response.ok) {
                const data = await response.json();
                setName(data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`);
                setLoggedIn(true);
                socket.emit("join-lobby", data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`);
            } else {
                setLoggedIn(false);
                setName("");
            }
        } catch (err) {
            console.error("Auth check failed:", err);
            setLoggedIn(false);
            setName("");
        }
    };
    checkAuthStatus();

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
      setBombError(""); // Clear any previous bomb errors
    });

    socket.on("board-update", (game) => {
      setBoard(game.board);
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false);
      setBombError(""); // Clear bomb error on board update
    });

    socket.on("wait-bomb-center", () => {
      setBombMode(true);
      setBombError(""); // Clear previous errors when entering bomb mode
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
      setBombError(""); // Clear bomb error
      // Refresh lobby players list will be automatic on server disconnect update
    });

    // --- NEW: Bomb error listener ---
    socket.on("bomb-error", (msg) => {
      setBombError(msg); // Set the error message
      setBombMode(false); // Exit bomb mode on error
      console.error("Bomb Error:", msg);
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
      socket.off("bomb-error"); // Clean up new listener
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
      // --- NEW: Client-side validation before emitting bomb-center ---
      const MIN_COORD = 2; // For 3rd line/column (0-indexed)
      const MAX_COORD_X = 13; // For 14th column (16-1 - 2)
      const MAX_COORD_Y = 13; // For 14th line (16-1 - 2)

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        setBombError("Bomb center must be within the highlighted 12x12 area.");
        console.log(`Client-side: Bomb center (${x},${y}) out of bounds.`);
        return; // Prevent emitting to server
      }

      // Check if all tiles in the 5x5 area are already revealed
      let allTilesRevealed = true;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const checkX = x + dx;
          const checkY = y + dy;
          if (checkX >= 0 && checkX < board[0].length && checkY >= 0 && checkY < board.length) {
            if (!board[checkY][checkX].revealed) {
              allTilesRevealed = false;
              break;
            }
          } else {
            // If any part of the bomb area is outside the board, it's not "all revealed"
            allTilesRevealed = false;
            break;
          }
        }
        if (!allTilesRevealed) break;
      }

      if (allTilesRevealed) {
        setBombError("All tiles in the bomb's blast area are already revealed.");
        console.log(`Client-side: Bomb area at (${x},${y}) already fully revealed.`);
        return; // Prevent emitting to server
      }
      // --- END NEW CLIENT-SIDE VALIDATION ---

      setBombError(""); // Clear error if validation passes
      socket.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      setBombError(""); // Clear error when clicking a regular tile
      socket.emit("tile-click", { gameId, x, y });
    }
  };

  const useBomb = () => {
    if (bombMode) {
      setBombMode(false); // Cancel bomb mode
      setBombError(""); // Clear error when cancelling
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      socket.emit("use-bomb", { gameId });
    }
  };

  const backToLobby = () => {
    if (gameId) {
        socket.emit("leave-game", { gameId });
    }

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
    setBombError(""); // Clear bomb error
};

  const logout = async () => {
  try {
    await fetch("https://minesweeper-flags-backend.onrender.com/logout", {
      method: "GET",
      credentials: "include",
    });

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
    setBombError(""); // Clear bomb error
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
      {/* Display bomb error if any */}
      {bombError && <p style={{ color: 'red', fontWeight: 'bold' }}>{bombError}</p>}
      <p>
        Score 🔴 {scores[1]} | 🔵 {scores[2]}
      </p>

      {gameOver && (
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
