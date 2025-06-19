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
  const [authChecked, setAuthChecked] = useState(false); // New state to track if initial auth check is done

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

  // Initial check on component mount and on login/logout
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
          method: "GET",
          credentials: "include",
        });
        if (response.ok) {
          const data = await response.json();
          setName(data.user.displayName || `User_${data.user.id.substring(0, 8)}`);
          setLoggedIn(true);
        } else {
          setLoggedIn(false);
          setName("");
        }
      } catch (err) {
        console.error("Auth check failed:", err);
        setLoggedIn(false);
        setName("");
      } finally {
        setAuthChecked(true); // Mark authentication check as complete
      }
    };

    checkAuthStatus(); // Run once on component mount

    // Optional: Re-run auth check on socket connect/reconnect to ensure consistency
    // socket.on('connect', checkAuthStatus);
    // return () => {
    //   socket.off('connect', checkAuthStatus);
    // };

  }, []); // Run only once on component mount


  // This useEffect handles joining the lobby once authenticated and name is set
  useEffect(() => {
    // Only join lobby if logged in, name is set, and auth check is done
    if (loggedIn && name.trim() && authChecked) {
      console.log(`Attempting to join lobby with name: ${name}`);
      socket.emit("join-lobby", name.trim());
    }
  }, [loggedIn, name, authChecked]); // Depend on loggedIn, name, and authChecked states


  useEffect(() => {
    socket.on("join-error", (msg) => {
      alert(msg);
      setLoggedIn(false); // Force logout if lobby join fails due to auth
      setName("");
      setAuthChecked(false); // Reset auth check
      window.location.reload(); // Reload to clear potentially bad state
    });

    socket.on("lobby-joined", () => {
      setLoggedIn(true); // Redundant, but ensures consistency
      console.log("Frontend: Lobby joined successfully!");
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
      console.log("Frontend: Game started! My player number:", data.playerNumber);
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
    });

    socket.on("game-restarted", (data) => {
      console.log("Frontend: Game restarted by server. Received data:", data);
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      setBoard(data.board);
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false);
      alert("Game restarted: Blank tile hit before any flags!");
      console.log("Frontend: Game state updated. Current gameId:", data.gameId);
    });

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
      socket.off("opponent-reconnected");
    };
  }, []); // No dependencies, as event listeners are stable


  const invitePlayer = (id) => {
    if (loggedIn && id !== socket.id) { // Still use socket.id for client-side invite target
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
      setBombMode(false);
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

  // Show loading/checking auth status
  if (!authChecked) {
    return <div className="lobby"><h2>Checking authentication status...</h2></div>;
  }

  if (!loggedIn) {
    return (
      <div className="lobby">
        <h2>Login with Google to join the lobby</h2>
        <GoogleLogin
          onLogin={(googleName) => {
            setName(googleName);
            // This `socket.emit("join-lobby", googleName);` is now handled by the new useEffect
            // based on `loggedIn` and `name` state.
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
