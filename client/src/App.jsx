// App.jsx
import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin";
import "./App.css";

// Initialize Socket.IO connection with credentials
// This is CRUCIAL for the backend to recognize the authenticated session.
const socket = io("https://minesweeper-flags-backend.onrender.com", {
  withCredentials: true, // Tell Socket.IO to send cookies with the handshake
});

function App() {
  // === Lobby & Authentication State ===
  const [name, setName] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [playersList, setPlayersList] = useState([]);
  const [message, setMessage] = useState(""); // General message/error display

  // === Game State ===
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
  const [unfinishedGames, setUnfinishedGames] = useState([]); // NEW: State for unfinished games

  // --- Helper to display messages (replaces alert) ---
  const showMessage = (msg, isError = false) => {
    setMessage(msg);
    if (isError) {
      console.error(msg);
    } else {
      console.log(msg);
    }
    // Clear message after some time (e.g., 5 seconds)
    setTimeout(() => setMessage(""), 5000);
  };

  // --- Initial Authentication Check on Component Mount ---
  useEffect(() => {
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
          console.log("Frontend: Auth check successful, user:", data.user.displayName || data.user.name);
          socket.emit("join-lobby", data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`);
        } else {
          setLoggedIn(false);
          setName("");
          console.log("Frontend: Auth check failed (response not ok).");
        }
      } catch (err) {
        console.error("Frontend: Error during auth check:", err);
        setLoggedIn(false);
        setName("");
      }
    };
    checkAuthStatus();

    // --- Socket.IO Event Listeners ---
    socket.on("join-error", (msg) => {
      showMessage(msg, true); // Use showMessage for errors
      setLoggedIn(false);
      setName("");
      window.location.reload();
    });

    socket.on("lobby-joined", (userName) => {
      setLoggedIn(true);
      setName(userName);
      showMessage(`Lobby joined successfully as ${userName}!`);
      socket.emit("request-unfinished-games");
    });

    socket.on("players-list", (players) => {
      setPlayersList(players);
    });

    socket.on("game-invite", (inviteData) => {
      setInvite(inviteData);
      showMessage(`Invitation from ${inviteData.fromName}!`);
    });

    socket.on("invite-rejected", ({ fromName, reason }) => {
      showMessage(`${fromName} rejected your invitation. ${reason ? `Reason: ${reason}` : ''}`, true);
    });

    socket.on("game-start", (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      // IMPORTANT: Deserialize the board received from the backend
      setBoard(JSON.parse(data.board));
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
      setMessage(""); // Clear message when game starts
      console.log("Frontend: Game started! My player number:", data.playerNumber);
      setUnfinishedGames([]); // Clear unfinished games list as a game has started/resumed
    });

    socket.on("board-update", (game) => {
      // IMPORTANT: Deserialize the board received from the backend
      setBoard(JSON.parse(game.board));
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false);
      setMessage(""); // Clear message on board update
    });

    socket.on("wait-bomb-center", () => {
      setBombMode(true);
      setMessage("Select 5x5 bomb center.");
    });

    socket.on("opponent-left", () => {
      showMessage("Opponent left the game. Returning to lobby.", true);
      setGameId(null);
      setPlayerNumber(null);
      setBoard([]);
      setTurn(null);
      setScores({ 1: 0, 2: 0 });
      setBombsUsed({ 1: false, 2: false });
      setGameOver(false);
      setOpponentName("");
      setBombMode(false);
      socket.emit("request-unfinished-games"); // Request updated unfinished games list after returning to lobby
    });

    socket.on("bomb-error", (msg) => {
      showMessage(msg, true);
      setBombMode(false); // Exit bomb mode on error
    });

    socket.on("receive-unfinished-games", (games) => {
      // Before setting, ensure boards are deserialized
      const deserializedGames = games.map(game => ({
          ...game,
          board: JSON.parse(game.board) // Deserialize board for each unfinished game
      }));
      setUnfinishedGames(deserializedGames);
      console.log("Received unfinished games:", deserializedGames);
    });

    socket.on("opponent-reconnected", ({ name }) => {
        showMessage(`${name} has reconnected!`);
    });

    socket.on("game-restarted", (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      setBoard(JSON.parse(data.board)); // Deserialize board for restarted game
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
      setMessage("Game restarted!");
      console.log("Frontend: Game restarted!");
    });


    // Cleanup function for useEffect
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
      socket.off("bomb-error");
      socket.off("receive-unfinished-games");
      socket.off("opponent-reconnected");
      socket.off("game-restarted");
    };
  }, []);

  // --- User Interaction Functions ---

  const invitePlayer = (id) => {
    if (loggedIn && id !== socket.id) {
      socket.emit("invite-player", id);
      showMessage("Invitation sent.");
    }
  };

  const respondInvite = (accept) => {
    if (invite) {
      socket.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null); // Clear the invitation after responding.
    }
  };

  const handleClick = (x, y) => {
    if (!gameId) return;
    if (bombMode) {
      // --- Client-side validation before emitting bomb-center ---
      const MIN_COORD = 2; // For 3rd line/column (0-indexed)
      const MAX_COORD_X = 13; // For 14th column (16-1 - 2)
      const MAX_COORD_Y = 13; // For 14th line (16-1 - 2)

      if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
        showMessage("Bomb center must be within the 12x12 area.", true);
        return;
      }

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
            allTilesRevealed = false;
            break;
          }
        }
        if (!allTilesRevealed) break;
      }

      if (allTilesRevealed) {
        showMessage("All tiles in the bomb's blast area are already revealed.", true);
        return;
      }
      // --- END CLIENT-SIDE VALIDATION ---

      setMessage(""); // Clear message if validation passes
      socket.emit("bomb-center", { gameId, x, y });
    } else if (playerNumber === turn && !gameOver) {
      setMessage(""); // Clear message when clicking a regular tile
      socket.emit("tile-click", { gameId, x, y });
    }
  };

  const useBomb = () => {
    if (bombMode) {
      setBombMode(false);
      setMessage(""); // Clear message when cancelling
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1]) {
      socket.emit("use-bomb", { gameId });
    } else {
        if (bombsUsed[playerNumber]) {
            showMessage("You have already used your bomb!", true);
        } else if (scores[playerNumber] >= scores[playerNumber === 1 ? 2 : 1]) {
            showMessage("You can only use the bomb when you are behind in score!", true);
        }
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
    setMessage(""); // Clear message
    setUnfinishedGames([]); // Clear for re-fetch
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
    setMessage(""); // Clear message
	window.location.reload();
  } catch (err) {
    console.error("Logout failed", err);
    showMessage("Logout failed. Please try again.", true);
  }
};

  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: "red" }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: "blue" }}>🏴‍</span>;
      return "";
    }
    // Apply number-specific class for coloring
    if (tile.adjacentMines > 0) {
      return <span className={`number-${tile.adjacentMines}`}>{tile.adjacentMines}</span>;
    }
    return "";
  };

  // --- NEW: Resume Game Function ---
  const resumeGame = (gameIdToResume) => {
    if (gameIdToResume) {
        socket.emit("resume-game", { gameId: gameIdToResume });
        showMessage("Attempting to resume game...");
    }
  };


  // --- Conditional Rendering based on App State ---

  if (!loggedIn) {
    return (
      <div className="lobby">
        {message && <p className="app-message" style={{color: 'red'}}>{message}</p>}
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
        {message && <p className="app-message" style={{color: 'green'}}>{message}</p>} {/* Show general success messages */}
        {message && message.includes("Error") && <p className="app-message" style={{color: 'red'}}>{message}</p>} {/* Show errors in red */}

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

        {/* --- NEW: Unfinished Games List in Lobby --- */}
        <div className="unfinished-games-section">
            <h3>Your Unfinished Games</h3>
            {unfinishedGames.length === 0 ? (
                <p>No unfinished games found.</p>
            ) : (
                <ul className="unfinished-game-list">
                    {unfinishedGames.map(game => (
                        <li key={game.gameId} className="unfinished-game-item">
                            Game vs. {game.opponentName} ({game.status === 'active' ? 'Active' : 'Abandoned'}) - Last updated: {game.lastUpdated}
                            <button onClick={() => resumeGame(game.gameId)} className="bomb-button">Resume</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
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
      {message && <p className="app-message" style={{ color: 'red', fontWeight: 'bold' }}>{message}</p>}
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
