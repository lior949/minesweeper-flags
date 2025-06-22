// App.jsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin"; // Assuming GoogleLogin component exists
import FacebookLogin from "./FacebookLogin"; // Assuming GoogleLogin component exists
import AuthCallback from "./AuthCallback"; // NEW: Import AuthCallback component
import "./App.css"; // Ensure you have App.css for styling

// Helper function: Converts an ArrayBuffer to a hexadecimal string.
const bufferToHex = (buffer) => {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
};

// Helper function: Hashes a message using SHA-256 and converts it into a 5-digit number.
// This function takes a portion of the SHA-256 hash, converts it to a decimal number,
// and then takes the modulo 100,000 to get a 5-digit number, padded with leading zeros.
const generate5DigitGuestId = async (message) => {
    try {
        const msgBuffer = new TextEncoder().encode(message); // Encode message as UTF-8
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); // Hash the message
        const fullHashHex = bufferToHex(hashBuffer); // Convert full hash to hex string

        // Take a portion of the hash (e.g., first 8 characters) to convert to a number
        // Using a slice helps ensure enough entropy for the conversion
        const hashPortion = fullHashHex.substring(0, 8); // e.g., "a1b2c3d4"
        let decimalValue = parseInt(hashPortion, 16); // Convert hex to decimal

        // Take modulo 100,000 to get a 5-digit number, then pad with leading zeros
        const fiveDigitId = (decimalValue % 100000).toString().padStart(5, '0');
        return fiveDigitId;
    } catch (error) {
        console.error("Error generating guest ID:", error);
        // Fallback or error handling if crypto.subtle is not available or fails
        return Math.floor(10000 + Math.random() * 90000).toString(); // Random 5-digit number
    }
};

const socket = io("https://minesweeper-flags.onrender.com", {
  withCredentials: true,
});

function App() {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [lobbyPlayers, setLobbyPlayers] = useState([]);
  const [opponentName, setOpponentName] = useState("");
  const [inGame, setInGame] = useState(false);
  const [gameId, setGameId] = useState(null);
  const [board, setBoard] = useState([]);
  const [playerNumber, setPlayerNumber] = useState(null);
  const [turn, setTurn] = useState(null);
  const [scores, setScores] = useState({ 1: 0, 2: 0 });
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false });
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState(null); // 0 for tie, 1 or 2 for player number
  const [message, setMessage] = useState("");
  const [guestName, setGuestName] = useState("");
  const [showGuestInput, setShowGuestInput] = useState(false);
  const [guestId, setGuestId] = useState("");
  const [lastClickedTile, setLastClickedTile] = useState({ 1: null, 2: null });

  const [bombMode, setBombMode] = useState(false);
  const [highlightedBombArea, setHighlightedBombArea] = useState([]);
  const [hoveredTile, setHoveredTile] = useState(null);

  const [unfinishedGames, setUnfinishedGames] = useState([]);
  const [observableGames, setObservableGames] = useState([]); // NEW: State for observable games
  const [isObserver, setIsObserver] = useState(false); // NEW: State to track if current user is an observer

  const gameBoardRef = useRef(null); // Ref for the game board element

  const API_URL = "https://minesweeper-flags.onrender.com"; // Your backend URL

  const checkAuthStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth-status`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include", // Important for sending cookies
      });
      const data = await response.json();
      if (data.isAuthenticated) {
        setUser(data.user);
        setIsAuthenticated(true);
        console.log("Authenticated user:", data.user);
        socket.emit("join-lobby");
      } else {
        setUser(null);
        setIsAuthenticated(false);
        console.log("User not authenticated.");
      }
    } catch (error) {
      console.error("Error checking auth status:", error);
      setUser(null);
      setIsAuthenticated(false);
    }
  }, [API_URL]);

  useEffect(() => {
    checkAuthStatus();

    socket.on("connect", () => {
      console.log("Connected to Socket.IO server.");
      setMessage("Connected to server.");
      if (isAuthenticated) {
        socket.emit("join-lobby"); // Re-join lobby on reconnect if already authenticated
      }
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from Socket.IO server.");
      setMessage("Disconnected from server.");
    });

    socket.on("authentication-pending", () => {
        console.log("Authentication pending from server. Please log in.");
        setMessage("Please log in to join the lobby.");
    });

    socket.on("lobby-joined", (userName) => {
        setMessage(`Joined lobby as ${userName}.`);
        socket.emit("request-unfinished-games"); // Request unfinished games when lobby is joined
        socket.emit("request-observable-games"); // NEW: Request observable games
    });

    socket.on("update-player-list", (players) => {
      setLobbyPlayers(players);
    });

    socket.on("no-opponent-found", () => {
      setMessage("No opponent found. Waiting for another player...");
    });

    socket.on("game-start", (gameData) => {
      console.log("Game started:", gameData);
      setGameId(gameData.gameId);
      setBoard(JSON.parse(gameData.board));
      setPlayerNumber(gameData.playerNumber);
      setTurn(gameData.turn);
      setScores(gameData.scores);
      setBombsUsed(gameData.bombsUsed || { 1: false, 2: false }); // Ensure bombsUsed is initialized
      setGameOver(gameData.gameOver);
      setLastClickedTile(gameData.lastClickedTile || { 1: null, 2: null });
      setOpponentName(gameData.opponentName);
      setInGame(true);
      setMessage(`Game ${gameData.gameId} started!`);
      setBombMode(false); // Reset bomb mode on game start/rejoin

      // NEW: Handle observer state
      if (gameData.isObserver) {
          setIsObserver(true);
          setPlayerNumber(null); // Observers don't have a player number
          setBombsUsed({ 1: true, 2: true }); // Disable bomb UI for observers
          setMessage(`Observing game ${gameData.gameId}`);
      } else {
          setIsObserver(false);
      }
    });

    socket.on("board-update", (gameData) => {
      setBoard(JSON.parse(gameData.board));
      setTurn(gameData.turn);
      setScores(gameData.scores);
      setBombsUsed(gameData.bombsUsed);
      setGameOver(gameData.gameOver);
      setLastClickedTile(gameData.lastClickedTile || { 1: null, 2: null });
      if (gameData.gameOver) {
        setMessage("Game Over!");
      }
      setBombMode(false); // Always turn off bomb mode after a tile click or bomb use
      setHighlightedBombArea([]); // Clear bomb highlight
    });

    socket.on("game-over", ({ winner, scores }) => {
      setGameOver(true);
      setWinner(winner);
      setScores(scores);
      setMessage(
        winner === 0
          ? "It's a tie!"
          : `Player ${winner} wins with scores: P1: ${scores[1]}, P2: ${scores[2]}!`
      );
      setBombMode(false); // Ensure bomb mode is off
      setHighlightedBombArea([]); // Clear bomb highlight
    });

    socket.on("game-restarted", (gameData) => {
        setBoard(JSON.parse(gameData.board));
        setTurn(gameData.turn);
        setScores(gameData.scores);
        setBombsUsed(gameData.bombsUsed);
        setGameOver(gameData.gameOver);
        setWinner(null);
        setLastClickedTile({ 1: null, 2: null });
        setMessage("Game has been restarted!");
        setBombMode(false); // Reset bomb mode
        setHighlightedBombArea([]); // Clear bomb highlight
        setIsObserver(false); // Ensure observer state is reset if game restarts
        // Re-join lobby if in observer mode and game restarts (new game, so observers need to re-select)
        if (isObserver) {
            setInGame(false); // Go back to lobby
            socket.emit("join-lobby"); // Re-request observable games
        }
    });


    socket.on("receive-invite", ({ from, fromSocketId, fromUserId }) => {
      const confirmInvite = window.confirm(
        `${from} (${fromUserId}) wants to play a game! Accept?`
      );
      if (confirmInvite) {
        socket.emit("start-game", fromSocketId);
      } else {
        socket.emit("decline-invite", fromSocketId);
      }
    });

    socket.on("invite-sent", (targetName) => {
        setMessage(`Invite sent to ${targetName}.`);
    });

    socket.on("invite-declined", (declinerName) => {
        setMessage(`${declinerName} declined your invite.`);
    });

    socket.on("opponent-left", () => {
      setMessage("Your opponent has left the game. Game paused, can be resumed from 'Unfinished Games'.");
      // Keep inGame true, but allow user to go back to lobby
      setGameOver(true); // Treat as game over from player perspective to prevent further moves
      setWinner(null); // No winner, game just ended due to leave
    });

    socket.on("opponent-reconnected", () => {
        setMessage("Your opponent has reconnected!");
    });


    socket.on("error-message", (msg) => {
      setMessage(`Error: ${msg}`);
      console.error("Socket error:", msg);
    });

    socket.on("bomb-mode-active", () => {
      setBombMode(true);
      setMessage("Bomb mode activated! Click a tile to blast a 3x3 area.");
    });

    socket.on("bomb-mode-inactive", () => {
      setBombMode(false);
      setHighlightedBombArea([]);
      setMessage("Bomb mode canceled.");
    });

    socket.on("receive-unfinished-games", (games) => {
      console.log("Received unfinished games:", games);
      setUnfinishedGames(games);
    });

    // NEW: Handle observable games
    socket.on("receive-observable-games", (games) => {
        console.log("Received observable games:", games);
        setObservableGames(games);
    });

    // NEW: Observer joined/left messages
    socket.on("observer-joined", ({ name }) => {
        setMessage(`${name} is now observing the game.`);
    });
    socket.on("observer-left", ({ name }) => {
        setMessage(`${name} has stopped observing.`);
    });
    socket.on("player-disconnected", ({ name }) => {
        setMessage(`Player ${name} has disconnected from the game.`);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("authentication-pending");
      socket.off("lobby-joined");
      socket.off("update-player-list");
      socket.off("no-opponent-found");
      socket.off("game-start");
      socket.off("board-update");
      socket.off("game-over");
      socket.off("game-restarted");
      socket.off("receive-invite");
      socket.off("invite-sent");
      socket.off("invite-declined");
      socket.off("opponent-left");
      socket.off("opponent-reconnected");
      socket.off("error-message");
      socket.off("bomb-mode-active");
      socket.off("bomb-mode-inactive");
      socket.off("receive-unfinished-games");
      socket.off("receive-observable-games"); // NEW
      socket.off("observer-joined"); // NEW
      socket.off("observer-left"); // NEW
      socket.off("player-disconnected"); // NEW
    };
  }, [isAuthenticated, checkAuthStatus, isObserver]); // Added isObserver to dependencies

  // Function to handle guest login
  const handleGuestLogin = async (e) => {
    e.preventDefault();
    if (!guestName.trim()) {
      setMessage("Please enter a name.");
      return;
    }
    const id = await generate5DigitGuestId(guestName.trim() + Date.now()); // Unique ID
    setGuestId(id);

    try {
      const response = await fetch(`${API_URL}/api/guest-login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ name: guestName.trim(), guestId: id }),
      });
      const data = await response.json();
      if (response.ok) {
        setUser(data.user);
        setIsAuthenticated(true);
        setMessage("Logged in as guest!");
        setShowGuestInput(false); // Hide input after successful login
        socket.emit("join-lobby"); // Join lobby after guest login
      } else {
        setMessage(`Guest login failed: ${data.message}`);
      }
    } catch (error) {
      console.error("Guest login fetch error:", error);
      setMessage("Failed to connect to server for guest login.");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_URL}/api/logout`, {
        method: "GET",
        credentials: "include",
      });
      setUser(null);
      setIsAuthenticated(false);
      setLobbyPlayers([]);
      setInGame(false);
      setGameId(null);
      setMessage("Logged out.");
      setShowGuestInput(false); // Hide guest input on logout
      setUnfinishedGames([]); // Clear unfinished games on logout
      setObservableGames([]); // Clear observable games on logout
      setIsObserver(false); // Reset observer state
    } catch (error) {
      console.error("Error logging out:", error);
      setMessage("Logout failed.");
    }
  };

  const findGame = () => {
    socket.emit("find-game");
    setMessage("Searching for opponent...");
  };

  const startGame = (opponentSocketId) => {
    socket.emit("start-game", opponentSocketId);
  };

  const backToLobby = () => {
    if (inGame && gameId) {
        if (isObserver) { // NEW: If currently an observer, send leave-observer-game
            socket.emit("leave-observer-game", { gameId });
        } else { // Otherwise, it's a player leaving the game
            socket.emit("leave-game", { gameId });
        }
    }
    setInGame(false);
    setGameId(null);
    setBoard([]);
    setPlayerNumber(null);
    setTurn(null);
    setScores({ 1: 0, 2: 0 });
    setBombsUsed({ 1: false, 2: false });
    setGameOver(false);
    setWinner(null);
    setOpponentName("");
    setLastClickedTile({ 1: null, 2: null });
    setBombMode(false);
    setHighlightedBombArea([]);
    setMessage("Returned to lobby.");
    // Re-request lists when back in lobby
    socket.emit("request-unfinished-games");
    socket.emit("request-observable-games"); // NEW
    setIsObserver(false); // Ensure observer state is false
  };

  const resumeGame = (gameToResume) => {
    // This logic is handled by the server on "join-lobby" if userGameMap has an entry.
    // So, we just need to ensure the user is 'inGame' and the server will send 'game-start'.
    // The previous implementation already handles this, but client needs to transition to game view.
    setGameId(gameToResume.gameId);
    setInGame(true);
    setMessage(`Resuming game ${gameToResume.gameId}...`);
    // The server will send the full game-start event upon rejoining the lobby,
    // which then populates the board, scores etc.
  };

  // NEW: Function to join a game as an observer
  const joinObserverGame = (gameToObserve) => {
      console.log("Attempting to observe game:", gameToObserve);
      socket.emit("join-observer-game", { gameId: gameToObserve.gameId });
      setMessage(`Attempting to observe game ${gameToObserve.gameId}...`);
  };


  const handleClick = (x, y) => {
    if (gameOver || isObserver || bombMode) { // NEW: Prevent clicks if observer or in bomb mode
      console.log("Cannot click: Game over, is observer, or in bomb mode.");
      return;
    }
    if (playerNumber !== turn) {
      setMessage("It's not your turn!");
      return;
    }
    socket.emit("tile-click", { gameId, x, y });
  };

  const handleUseBomb = () => {
    if (gameOver || playerNumber !== turn || bombsUsed[playerNumber] || isObserver) { // NEW: Prevent if observer
        setMessage("Cannot use bomb: Game over, not your turn, bomb already used, or you are an observer.");
        return;
    }
    setBombMode(true);
    socket.emit("use-bomb", { gameId, playerNumber });
  };

  const handleCancelBomb = () => {
    setBombMode(false);
    setHighlightedBombArea([]);
    socket.emit("cancel-bomb", { gameId, playerNumber });
  };

  const handleBombTileClick = (x, y) => {
    if (!bombMode || !gameId || !playerNumber || isObserver) { // NEW: Prevent if observer
        return;
    }
    // Logic to send bomb center to server
    socket.emit("bomb-center-selected", { gameId, x, y, playerNumber });
  };

  const handleMouseMoveOnGrid = useCallback((e) => {
    if (!bombMode || !gameBoardRef.current) {
        setHighlightedBombArea([]);
        setHoveredTile(null);
        return;
    }

    const { clientX, clientY } = e;
    const { left, top, width, height } = gameBoardRef.current.getBoundingClientRect();

    const gridSize = Math.sqrt(board.length * board[0].length); // Assuming square grid based on CSS
    const tileWidth = width / gridSize;
    const tileHeight = height / gridSize;

    const x = Math.floor((clientX - left) / tileWidth);
    const y = Math.floor((clientY - top) / tileHeight);

    if (x >= 0 && x < board[0].length && y >= 0 && y < board.length) {
        setHoveredTile({ x, y });
        const newHighlightedArea = [];
        const blastRadius = 1; // 3x3 area
        for (let dy = -blastRadius; dy <= blastRadius; dy++) {
            for (let dx = -blastRadius; dx <= blastRadius; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < board[0].length && ny >= 0 && ny < board.length) {
                    newHighlightedArea.push({ x: nx, y: ny });
                }
            }
        }
        setHighlightedBombArea(newHighlightedArea);
    } else {
        setHighlightedBombArea([]);
        setHoveredTile(null);
    }
}, [bombMode, board]);


  const handleMouseLeaveGrid = useCallback(() => {
    if (bombMode) {
        setHighlightedBombArea([]);
        setHoveredTile(null);
    }
  }, [bombMode]);


  const restartGame = () => {
    if (gameId) {
      socket.emit("restart-game", { gameId });
    }
  };


  const renderTile = (tile) => {
    if (!tile.revealed) {
      return null;
    }
    if (tile.isMine) {
      return "💣";
    }
    if (tile.adjacentMines > 0) {
      return tile.adjacentMines;
    }
    return null;
  };

  if (window.location.pathname.startsWith("/auth/callback")) {
    return <AuthCallback />;
  }

  return (
    <div className="app-container">
      {!isAuthenticated && (
        <div className="auth-section">
          <h2>Welcome to Minesweeper Flags</h2>
          <p>Please log in to play.</p>
          <GoogleLogin />
          <FacebookLogin />
          <button onClick={() => setShowGuestInput(!showGuestInput)} className="guest-login-button">
            {showGuestInput ? "Hide Guest Login" : "Play as Guest"}
          </button>
          {showGuestInput && (
            <form onSubmit={handleGuestLogin} className="guest-input-form">
              <input
                type="text"
                placeholder="Enter your name"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                maxLength="20"
                required
              />
              <button type="submit">Go!</button>
            </form>
          )}
        </div>
      )}

      {isAuthenticated && (
        <div className="main-app">
          <div className="header">
            <h1>Minesweeper Flags</h1>
            <p>
              Welcome, {user?.name} ({user?.provider})! |{" "}
              <button onClick={handleLogout} className="logout-button">
                Logout
              </button>
            </p>
            <p className="message">{message}</p>
          </div>

          {!inGame && (
            <div className="lobby">
              <h2>Lobby</h2>
              <button onClick={findGame} className="find-game-button">
                Find Opponent
              </button>{" "}
              <p>Or invite a player:</p>
              {lobbyPlayers.length > 0 ? (
                <ul className="player-list">
                  {lobbyPlayers.map((player) => (
                    <li key={player.id} className="player-item">
                      {player.name}{" "}
                      <button
                        onClick={() => startGame(player.id)}
                        className="invite-button"
                      >
                        Invite
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No other players in lobby.</p>
              )}

              {/* Unfinished Games List */}
              {unfinishedGames.length > 0 && (
                <div className="unfinished-games-section">
                  <h3>Unfinished Games</h3>
                  <ul className="game-list">
                    {unfinishedGames.map((game) => (
                      <li key={game.gameId} className="game-item">
                        Game with {game.opponentName} - Scores: P1{" "}
                        {game.scores[1]} | P2 {game.scores[2]} (Last Updated:{" "}
                        {game.lastUpdated
                          ? new Date(game.lastUpdated).toLocaleString()
                          : "N/A"}
                        )
                        <button
                          onClick={() => resumeGame(game)}
                          className="resume-button"
                        >
                          Resume
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* NEW: Observable Games List */}
              {observableGames.length > 0 && (
                <div className="observable-games-section">
                  <h3>Observable Games</h3>
                  <ul className="game-list">
                    {observableGames.map((game) => (
                      <li key={game.gameId} className="game-item">
                        {game.player1_name} vs {game.player2_name} - Scores:{" "}
                        {game.scores[1]} | {game.scores[2]} (Last Updated:{" "}
                        {game.lastUpdated
                          ? new Date(game.lastUpdated).toLocaleString()
                          : "N/A"}
                        )
                        <button
                          onClick={() => joinObserverGame(game)}
                          className="observe-button"
                        >
                          Observe
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            </div>
          )}

          {inGame && (
            <div className="game-container">
                <div className="game-info">
                    <h2>Game ID: {gameId}</h2>
                    {!isObserver ? ( // Display player-specific info only if not observer
                        <>
                            <p>You are Player {playerNumber}.</p>
                            <p>Opponent: {opponentName}</p>
                            <p>It's Player {turn}'s turn.</p>
                            <p>Your Score: {scores[playerNumber]}</p>
                            <p>Opponent Score: {scores[playerNumber === 1 ? 2 : 1]}</p>
                        </>
                    ) : (
                        <> {/* NEW: Observer view of game info */}
                            <p>You are Observing.</p>
                            <p>Players: {opponentName}</p> {/* opponentName will be "Player1 vs Player2" */}
                            <p>Current Turn: Player {turn}</p>
                            <p>Scores: P1: {scores[1]} | P2: {scores[2]}</p>
                        </>
                    )}
                </div>

                <div
                    ref={gameBoardRef}
                    className={`game-board ${bombMode ? "bomb-mode-cursor" : ""}`}
                    onMouseMove={handleMouseMoveOnGrid}
                    onMouseLeave={handleMouseLeaveGrid}
                >
                    {board.flatMap((row, y) =>
                      row.map((tile, x) => {
                        // Check if the current tile is part of the highlighted bomb area
                        const isHighlighted = highlightedBombArea.some(
                            (coord) => coord.x === x && coord.y === y
                        );
                        return (
                          <div
                            key={`${x}-${y}`}
                            className={`tile ${
                              tile.revealed ? "revealed" : "hidden"
                            } ${tile.isMine && tile.revealed ? "mine" : ""} ${
                              lastClickedTile[1]?.x === x && lastClickedTile[1]?.y === y ? "last-clicked-p1" : ""
                            } ${
                              lastClickedTile[2]?.x === x && lastClickedTile[2]?.y === y ? "last-clicked-p2" : ""
                            } ${isHighlighted ? "highlighted-bomb-area" : "" /* Apply highlight class */
                            }`}
                            onClick={() => (bombMode ? handleBombTileClick(x, y) : handleClick(x, y))}
                          >
                            {renderTile(tile)}
                          </div>
                        );
                      })
                    )}
                </div>

                {!isObserver && ( // NEW: Only show bomb controls to players
                    <div className="game-controls">
                        {!bombMode ? (
                            <button
                                onClick={handleUseBomb}
                                disabled={bombsUsed[playerNumber] || gameOver || playerNumber !== turn}
                                className="bomb-button"
                            >
                                {bombsUsed[playerNumber] ? "Bomb Used" : "Use Bomb"}
                            </button>
                        ) : (
                            <button onClick={handleCancelBomb} className="cancel-bomb-button">
                                Cancel Bomb
                            </button>
                        )}
                    </div>
                )}

                {gameOver && (
                  <div className="game-over-section">
                    <p>{winner === 0 ? "It's a Tie!" : `Player ${winner} Wins!`}</p>
                    <p>Final Scores: P1: {scores[1]} | P2: {scores[2]}</p>
                    {!isObserver && ( // NEW: Only allow players to restart the game
                        <button onClick={restartGame} className="restart-button">
                        Restart Game
                        </button>
                    )}
                  </div>
                )}

                <button onClick={backToLobby} className="back-to-lobby-button">
                  Back to Lobby
                </button>
            </div>
        )}
    </div>
  );
}

export default App;
