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

  // --- Helper Functions ---
  const resetGameState = () => {
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
    setMessage(""); // Clear any messages
    // Trigger fetching unfinished games after returning to lobby
    socket.emit("request-unfinished-games");
  };

  const clearMessage = () => {
    setMessage("");
  };

  // --- Socket.IO Event Handlers ---
  useEffect(() => {
    const handleJoinError = (msg) => {
      setMessage(msg);
      // Clear message after some time if it's an error
      setTimeout(clearMessage, 5000);
    };

    const handleLobbyJoined = () => {
      setLoggedIn(true);
      setMessage("Joined lobby successfully!");
      setTimeout(clearMessage, 3000);
      socket.emit("request-unfinished-games"); // Request unfinished games upon joining lobby
    };

    const handlePlayersList = (players) => {
      setPlayersList(players);
    };

    const handleGameInvite = (inviteData) => {
      setInvite(inviteData);
    };

    const handleInviteRejected = ({ fromName, reason }) => {
      setMessage(`${fromName} rejected your invitation.${reason ? ` Reason: ${reason}` : ''}`);
      setTimeout(clearMessage, 5000);
      setInvite(null); // Clear the invite if rejected
    };

    const handleGameStart = (data) => {
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      setBoard(data.board); // Board should be deserialized on backend if sent as string
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
      setMessage(`Game started! You are Player ${data.playerNumber}.`);
      setTimeout(clearMessage, 3000);
    };

    const handleBoardUpdate = (game) => {
      setBoard(game.board);
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false);
    };

    const handleWaitBombCenter = () => {
      setBombMode(true);
      setMessage("Select a 5x5 bomb center.");
      setTimeout(clearMessage, 5000);
    };

    const handleBombError = (msg) => {
        setMessage(msg);
        setTimeout(clearMessage, 5000);
        setBombMode(false); // Exit bomb mode on error
    };

    const handleOpponentLeft = () => {
      setMessage("Opponent left the game. Returning to lobby.");
      setTimeout(clearMessage, 5000);
      resetGameState();
    };

    const handleGameRestarted = (data) => {
        setGameId(data.gameId);
        setPlayerNumber(data.playerNumber);
        setBoard(data.board);
        setTurn(data.turn);
        setScores(data.scores);
        setBombsUsed(data.bombsUsed);
        setGameOver(data.gameOver);
        setOpponentName(data.opponentName);
        setBombMode(false);
        setMessage("Game restarted!");
        setTimeout(clearMessage, 3000);
    };

    const handleOpponentReconnected = ({ name }) => {
        setMessage(`${name} has reconnected!`);
        setTimeout(clearMessage, 3000);
    };

    const handleReceiveUnfinishedGames = (games) => {
        setUnfinishedGames(games);
    };


    // --- Socket.IO Event Listeners ---
    socket.on("join-error", handleJoinError);
    socket.on("lobby-joined", handleLobbyJoined);
    socket.on("players-list", handlePlayersList);
    socket.on("game-invite", handleGameInvite);
    socket.on("invite-rejected", handleInviteRejected);
    socket.on("game-start", handleGameStart);
    socket.on("board-update", handleBoardUpdate);
    socket.on("wait-bomb-center", handleWaitBombCenter);
    socket.on("bomb-error", handleBombError); // NEW listener
    socket.on("opponent-left", handleOpponentLeft);
    socket.on("game-restarted", handleGameRestarted); // NEW listener
    socket.on("opponent-reconnected", handleOpponentReconnected); // NEW listener
    socket.on("receive-unfinished-games", handleReceiveUnfinishedGames); // NEW listener


    // Initial check for authentication status on component mount
    const checkAuthStatus = async () => {
        try {
            const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
                method: "GET",
                credentials: "include", // IMPORTANT: Send cookies
            });
            if (response.ok) {
                const data = await response.json();
                const userDisplayName = data.user.displayName || `User_${data.user.id.substring(0, 8)}`;
                setName(userDisplayName);
                setLoggedIn(true);
                // After successful auth, join lobby. The backend will use the session's userId.
                socket.emit("join-lobby", userDisplayName);
            } else {
                setLoggedIn(false);
                setName("");
                setMessage("Not logged in. Please log in to play.");
            }
        } catch (err) {
            console.error("Auth check failed:", err);
            setLoggedIn(false);
            setName("");
            setMessage("Failed to connect to authentication service.");
            setTimeout(clearMessage, 5000);
        }
    };

    // Ensure this runs only once on mount
    if (!loggedIn) { // Only run if not already logged in
      checkAuthStatus();
    }


    // Cleanup function for useEffect
    return () => {
      socket.off("join-error", handleJoinError);
      socket.off("lobby-joined", handleLobbyJoined);
      socket.off("players-list", handlePlayersList);
      socket.off("game-invite", handleGameInvite);
      socket.off("invite-rejected", handleInviteRejected);
      socket.off("game-start", handleGameStart);
      socket.off("board-update", handleBoardUpdate);
      socket.off("wait-bomb-center", handleWaitBombCenter);
      socket.off("bomb-error", handleBombError);
      socket.off("opponent-left", handleOpponentLeft);
      socket.off("game-restarted", handleGameRestarted);
      socket.off("opponent-reconnected", handleOpponentReconnected);
      socket.off("receive-unfinished-games", handleReceiveUnfinishedGames);
    };
  }, [loggedIn]); // Rerun if loggedIn state changes (e.g., after successful login)


  // --- User Interaction Handlers ---
  const invitePlayer = (id) => {
    if (loggedIn && id !== socket.id) {
      socket.emit("invite-player", id);
      setMessage("Invitation sent.");
      setTimeout(clearMessage, 3000);
    }
  };

  const respondInvite = (accept) => {
    if (invite) {
      socket.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null); // Clear the invitation popup
      if (accept) {
        setMessage("Accepted invitation!");
      } else {
        setMessage("Rejected invitation.");
      }
      setTimeout(clearMessage, 3000);
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
      setBombMode(false); // Cancel bomb mode
      setMessage("Bomb mode cancelled.");
      setTimeout(clearMessage, 3000);
    } else if (!bombsUsed[playerNumber] && scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] && !gameOver) {
      // Only allow using bomb if current player's score is less than opponent's
      socket.emit("use-bomb", { gameId });
    }
  };

  const backToLobby = () => {
    if (gameId) {
        socket.emit("leave-game", { gameId });
    }
    resetGameState();
    setMessage("Returned to lobby.");
    setTimeout(clearMessage, 3000);
  };

  const restartGame = () => {
    if (gameId) {
        socket.emit("restart-game", { gameId });
        setMessage("Restarting game...");
        setTimeout(clearMessage, 3000);
    }
  };

  const resumeGame = (selectedGameId) => {
    if (selectedGameId) {
        socket.emit("resume-game", { gameId: selectedGameId });
        setMessage("Attempting to resume game...");
        setTimeout(clearMessage, 3000);
    }
  };


  const logout = async () => {
    try {
      await fetch("https://minesweeper-flags-backend.onrender.com/logout", {
        method: "GET",
        credentials: "include",
      });

      setLoggedIn(false);
      setName("");
      resetGameState(); // Reset all game and lobby states
      setMessage("Logged out successfully.");
      setTimeout(() => {
        clearMessage();
        window.location.reload(); // Force a full reload to clear all states and re-render login
      }, 2000);

    } catch (err) {
      console.error("Logout failed", err);
      setMessage("Logout failed. Please try again.");
      setTimeout(clearMessage, 5000);
    }
  };

  // --- Render Functions ---
  const renderTile = (tile) => {
    if (!tile.revealed) return "";
    if (tile.isMine) {
      if (tile.owner === 1) return <span style={{ color: "red", fontSize: "24px" }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: "blue", fontSize: "24px" }}>🚩</span>; // Changed to blue
      return "";
    }
    return tile.adjacentMines > 0 ? tile.adjacentMines : "";
  };

  // --- Main App Render Logic ---
  if (!loggedIn) {
    return (
      <div className="lobby">
        <h2>Login to Minesweeper Flags</h2>
        {message && <p className="app-message" style={{ color: 'red', fontWeight: 'bold' }}>{message}</p>}
        <GoogleLogin />
        {/* Potentially add FacebookLogin here */}
      </div>
    );
  }

  if (!gameId) {
    return (
      <div className="lobby">
        <div className="header">
            <h2>Lobby - Online Players</h2>
            <button onClick={logout} className="bomb-button">Logout</button>
        </div>
        {message && <p className="app-message">{message}</p>}
        <h3>Current Player: {name}</h3>

        {/* Unfinished Games Section */}
        {unfinishedGames.length > 0 && (
            <div className="unfinished-games-list">
                <h3>Your Unfinished Games</h3>
                <ul className="player-list">
                    {unfinishedGames.map((game) => (
                        <li key={game.gameId} className="player-item" onClick={() => resumeGame(game.gameId)}>
                            Game ID: {game.gameId.substring(0, 8)}... (vs. {game.opponentName}) - Status: {game.status} - Last Updated: {game.lastUpdated}
                        </li>
                    ))}
                </ul>
            </div>
        )}

        {/* Available Players Section */}
        <h3>Available Players</h3>
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
        <>
            <button className="bomb-button" onClick={backToLobby}>
              Back to Lobby
            </button>
            <button className="bomb-button" onClick={restartGame} style={{ marginLeft: '10px' }}>
              Restart Game
            </button>
        </>
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
