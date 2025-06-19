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

  // Join lobby - this might be redundant if GoogleLogin handles name
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

    // --- Critical: game-start fully initializes game state ---
    socket.on("game-start", (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber); // Player's assigned number (1 or 2)
      setBoard(data.board);
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false); // Ensure bomb mode is off
      console.log("Frontend: Game started! My player number:", data.playerNumber);
    });

    socket.on("board-update", (game) => {
      setBoard(game.board);
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false); // Always reset bomb mode after an update
    });

    socket.on("wait-bomb-center", () => {
      setBombMode(true);
    });

    // --- Crucial: opponent-left explicitly resets game state to lobby ---
    socket.on("opponent-left", () => {
      alert("Opponent left the game. Returning to lobby.");
      setGameId(null); // This is the key that sends you to the lobby UI
      setPlayerNumber(null);
      setBoard([]);
      setTurn(null);
      setScores({ 1: 0, 2: 0 });
      setBombsUsed({ 1: false, 2: false });
      setGameOver(false);
      setOpponentName("");
      setBombMode(false);
    });

    // --- MODIFIED game-restarted: fully re-initializes game state ---
    socket.on("game-restarted", (data) => {
      console.log("Frontend: Game restarted by server. Received data:", data);
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber); // Ensure player number is correctly set
      setBoard(data.board);
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver); // Should be false after restart
      setOpponentName(data.opponentName); // Ensure opponent name is set
      setBombMode(false); // Reset bomb mode
      alert("Game restarted: Blank tile hit before any flags!");
      console.log("Frontend: Game state updated. Current gameId:", data.gameId);
    });

    // --- NEW: Handle opponent reconnected ---
    socket.on("opponent-reconnected", ({ name }) => {
        alert(`${name} has reconnected!`);
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
      socket.off("game-restarted");
      socket.off("opponent-reconnected"); // Clean up new listener
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
    if (!gameId) return; // Must be in a game
    if (bombMode) {
      socket.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) { // Only click if it's your turn and game is not over
      socket.emit("tile-click", { gameId, x, y });
    }
  };

  const useBomb = () => {
    if (bombMode) {
      // Cancel bomb mode
      setBombMode(false);
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      // Only use bomb if not already used and currently behind in score
      socket.emit("use-bomb", { gameId });
    }
  };

  const backToLobby = () => {
    if (gameId) {
        socket.emit("leave-game", { gameId });
    }
    // These states are largely reset by opponent-left (if fired) or just going back to lobby view
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
  };

  const logout = async () => {
    try {
      await fetch("https://minesweeper-flags-backend.onrender.com/logout", {
        method: "GET",
        credentials: "include",
      });

      // Reset all frontend state relevant to being logged in or in a game
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
      window.location.reload(); // Force a full page reload to ensure session is cleared
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
            // This 'name' is then sent to join-lobby. The server will use it along with userId.
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
              key={p.id} // Use socket.id as key for display, but userId for server logic
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
