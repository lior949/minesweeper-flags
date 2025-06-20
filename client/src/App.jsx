/ App.jsx
import React, { useEffect, useState } from "react";
import io from "socket.io-client";
import GoogleLogin from "./GoogleLogin";
import "./App.css";

const socket = io("https://minesweeper-flags-backend.onrender.com");

function App() {
  // === Lobby & Authentication State ===
  const [name, setName] = useState(""); // User's display name
  const [loggedIn, setLoggedIn] = useState(false); // Authentication status
  const [playersList, setPlayersList] = useState([]); // List of other players in the lobby
  const [authChecked, setAuthChecked] = useState(false); // State to track if initial auth check is done

  // === Game State ===
  const [gameId, setGameId] = useState(null); // ID of the current game
  const [playerNumber, setPlayerNumber] = useState(null); // Player 1 or 2 in the current game
  const [board, setBoard] = useState([]); // Current game board state
  const [turn, setTurn] = useState(null); // Current player's turn
  const [scores, setScores] = useState({ 1: 0, 2: 0 }); // Scores for Player 1 and Player 2
  const [bombsUsed, setBombsUsed] = useState({ 1: false, 2: false }); // Track bomb usage for each player
  const [bombMode, setBombMode] = useState(false); // True if player is in bomb selection mode
  const [gameOver, setGameOver] = useState(false); // True if the game has ended
  const [opponentName, setOpponentName] = useState(""); // Name of the opponent
  const [invite, setInvite] = useState(null); // Stores incoming game invitation data
  const [bombError, setBombError] = useState(""); // State for bomb errors, from previous update
  const [unfinishedGames, setUnfinishedGames] = useState([]); // For unfinished games list

  // --- Initial Authentication Check on Component Mount ---
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        // Fetch to backend's /me endpoint to check current authentication status.
        // `credentials: "include"` is crucial to send session cookies.
        const response = await fetch("https://minesweeper-flags-backend.onrender.com/me", {
          method: "GET",
          credentials: "include",
        });

        if (response.ok) {
          const data = await response.json();
          // Set user's name and loggedIn status from the /me response.
          // Fallback to a generic name if displayName is not provided by Passport.
          setName(data.user.displayName || data.user.name || `User_${data.user.id.substring(0, 8)}`);
          setLoggedIn(true);
          console.log("Frontend: Auth check successful, user:", data.user.displayName || data.user.name);

          // REMOVED: socket.emit("join-lobby", ...) from here.
          // It will now be handled by the next useEffect.

        } else {
          // If auth check fails, set loggedIn to false and clear name.
          setLoggedIn(false);
          setName("");
          console.log("Frontend: Auth check failed (response not ok).");
        }
      } catch (err) {
        // Catch network errors or other fetch issues.
        console.error("Frontend: Error during auth check:", err);
        setLoggedIn(false);
        setName("");
      } finally {
        setAuthChecked(true); // Mark authentication check as complete regardless of outcome
      }
    };

    checkAuthStatus(); // Execute the authentication check once on component mount.

  }, []); // Empty dependency array means this runs once on mount


  // This useEffect will emit "join-lobby" once authentication is confirmed and name is set
  // This is the SOLE place `join-lobby` should be emitted after initial auth.
  useEffect(() => {
    if (loggedIn && name.trim() && authChecked) {
      console.log(`Frontend: User authenticated, attempting to join lobby with name: ${name}`);
      socket.emit("join-lobby", name.trim());
      // Request unfinished games only after joining the lobby successfully
      socket.emit("request-unfinished-games");
    } else if (authChecked && !loggedIn) {
        console.log("Frontend: Auth check complete, but not logged in. Waiting for user action.");
    }
  }, [loggedIn, name, authChecked]); // Dependencies: runs when these states change


  useEffect(() => {
    socket.on("join-error", (msg) => {
      alert(msg); // Display error messages from the server.
      // If join-lobby fails due to auth, force logout on client (ensure it's a hard refresh)
      setLoggedIn(false);
      setName("");
      setAuthChecked(false); // Reset auth check so it runs again
      // Using window.location.reload() can sometimes hide real issues or create a loop if not careful.
      // For now, let's keep it if it helps clear client state in tough situations.
      window.location.reload(); 
    });

    socket.on("lobby-joined", (userName) => {
      setLoggedIn(true); // Confirm successful lobby join.
      setName(userName); // Update name, potentially with the server-validated name.
      console.log(`Frontend: Lobby joined successfully as ${userName}!`);
      // Request unfinished games here again, to ensure it's fetched after a successful lobby join event
      socket.emit("request-unfinished-games");
    });

    socket.on("players-list", (players) => {
      setPlayersList(players); // Update the list of online players.
    });

    socket.on("game-invite", (inviteData) => {
      setInvite(inviteData); // Store incoming invite data.
    });

    socket.on("invite-rejected", ({ fromName, reason }) => {
      alert(`${fromName} rejected your invitation. Reason: ${reason || "N/A"}`); // Notify if invite is rejected.
    });

    socket.on("game-start", (data) => {
      // Initialize all game states when a game starts.
      setGameId(data.gameId);
      setPlayerNumber(data.playerNumber);
      // Ensure the board is parsed from JSON string if the server sends it as such
      setBoard(typeof data.board === 'string' ? JSON.parse(data.board) : data.board);
      setTurn(data.turn);
      setScores(data.scores);
      setBombsUsed(data.bombsUsed);
      setGameOver(data.gameOver);
      setOpponentName(data.opponentName);
      setBombMode(false); // Ensure bomb mode is off at game start.
      setBombError(""); // Clear any previous bomb errors
      setUnfinishedGames([]); // Clear unfinished games list when a game starts/resumes
      console.log("Frontend: Game started! My player number:", data.playerNumber);
    });

    socket.on("board-update", (game) => {
      // Update game states based on server-sent game object.
      // Ensure the board is parsed from JSON string if the server sends it as such
      setBoard(typeof game.board === 'string' ? JSON.parse(game.board) : game.board);
      setTurn(game.turn);
      setScores(game.scores);
      setBombsUsed(game.bombsUsed);
      setGameOver(game.gameOver);
      setBombMode(false); // Always reset bomb mode after a board update.
      setBombError(""); // Clear bomb error on board update
    });

    socket.on("wait-bomb-center", () => {
      setBombMode(true); // Activate bomb selection mode.
      setBombError(""); // Clear previous errors when entering bomb mode
    });

    socket.on("bomb-error", (msg) => {
      setBombError(msg); // Set the error message
      setBombMode(false); // Exit bomb mode on error
      console.error("Bomb Error:", msg);
    });

    socket.on("opponent-left", () => {
      alert("Opponent left the game. Returning to lobby.");
      // Reset all game-related states to return to the lobby view.
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
      socket.emit("request-unfinished-games"); // Request updated list
    });

    socket.on("game-restarted", (data) => {
        setGameId(data.gameId);
        setPlayerNumber(data.playerNumber);
        setBoard(typeof data.board === 'string' ? JSON.parse(data.board) : data.board);
        setTurn(data.turn);
        setScores(data.scores);
        setBombsUsed(data.bombsUsed);
        setGameOver(data.gameOver);
        setOpponentName(data.opponentName);
        setBombMode(false);
        setBombError("");
        console.log("Frontend: Game restarted!");
    });

    socket.on("opponent-reconnected", ({ name }) => {
        console.log(`${name} reconnected to the game.`);
        // Optionally, display a small message in the UI for a few seconds
    });

    socket.on("receive-unfinished-games", (games) => {
        // Deserialize the board string back to an object for each game
        const deserializedGames = games.map(game => ({
            ...game,
            board: JSON.parse(game.board)
        }));
        setUnfinishedGames(deserializedGames);
        console.log(`Received ${deserializedGames.length} unfinished games.`);
    });


    // Cleanup function for useEffect: unsubscribe from socket events when component unmounts.
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
      socket.off("game-restarted");
      socket.off("opponent-reconnected");
      socket.off("receive-unfinished-games");
    };
  }, []); // Empty dependency array means this useEffect runs once on mount and cleanup on unmount.

  // --- User Interaction Functions ---

  const invitePlayer = (id) => {
    // Only allow inviting if logged in and not inviting self.
    if (loggedIn && id !== socket.id) {
      socket.emit("invite-player", id);
      alert("Invitation sent.");
    }
  };

  const respondInvite = (accept) => {
    // Respond to an active invitation.
    if (invite) {
      socket.emit("respond-invite", { fromId: invite.fromId, accept });
      setInvite(null); // Clear the invitation after responding.
    }
  };

  const handleClick = (x, y) => {
    if (!gameId) return; // Must be in a game to click tiles.
    if (bombMode) {
      // --- Client-side validation before emitting bomb-center ---
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
    setUnfinishedGames([]); // Clear unfinished games list
    socket.emit("request-unfinished-games"); // Request updated list for lobby
};

const resumeGame = (gameToResume) => {
    socket.emit("resume-game", { gameId: gameToResume.gameId });
    setUnfinishedGames([]); // Clear list once attempting to resume
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
    setUnfinishedGames([]); // Clear unfinished games list
	window.location.reload();
  } catch (err) {
    console.error("Logout failed", err);
    alert("Logout failed. Please try again.");
  }
};

  // Helper function to render content inside a tile.
  const renderTile = (tile) => {
    if (!tile.revealed) return ""; // Hidden tiles show nothing.
    if (tile.isMine) {
      // Mines show flags based on owner.
      if (tile.owner === 1) return <span style={{ color: "red" }}>🚩</span>;
      if (tile.owner === 2) return <span style={{ color: "blue" }}>🏴</span>;
      return ""; // If revealed mine has no owner (shouldn't happen in game logic)
    }
    // Non-mine revealed tiles show adjacent mine count (if > 0).
    return tile.adjacentMines > 0 ? tile.adjacentMines : "";
  };

  // --- Conditional Rendering based on App State ---

  // Display initial loading/checking authentication status
  if (!authChecked) {
    return <div className="lobby"><h2>Checking authentication status...</h2></div>;
  }

  // If not logged in, show the Google Login component.
  if (!loggedIn) {
    return (
      <div className="lobby">
        <h2>Login with Google to join the lobby</h2>
        <GoogleLogin
          onLogin={(googleName) => {
            setName(googleName);
            // The `join-lobby` emission is now handled by the second useEffect
            // based on `loggedIn` and `name` state. No direct emit here.
          }}
        />
      </div>
    );
  }

  // If logged in but not in a game, show the lobby UI.
  if (!gameId) {
    return (
      <div className="lobby">
        <h2>Lobby - Online Players</h2>
        <button onClick={logout} className="bomb-button">Logout</button>

        <h3>Unfinished Games</h3>
        {unfinishedGames.length === 0 ? (
            <p>No unfinished games found.</p>
        ) : (
            <ul className="player-list"> {/* Reusing player-list style for consistency */}
                {unfinishedGames.map((game) => (
                    <li
                        key={game.gameId}
                        className="player-item"
                        onClick={() => resumeGame(game)}
                        title={`Resume game against ${game.opponentName} (Last updated: ${game.lastUpdated})`}
                    >
                        Vs. {game.opponentName} (Player {game.myPlayerNumber}) - Status: {game.status === 'active' ? 'Live' : 'Waiting'}
                    </li>
                ))}
            </ul>
        )}


        <h3>Other Online Players</h3>
        {playersList.length === 0 && <p>No other players online</p>}
        <ul className="player-list">
          {playersList.map((p) => (
            <li
              key={p.id} // Using socket.id as key for display, this is fine for simple list
              className="player-item"
              onDoubleClick={() => invitePlayer(p.id)} // Double-click to invite
              title="Double-click to invite"
            >
              {p.name}
            </li>
          ))}
        </ul>
        {/* Render invite popup if an invite is active */}
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

  // If in a game, show the game UI.
  return (
    <div className="app">
      <div className="header">
        <h1>Minesweeper Flags</h1>
        {/* Bomb button rendering logic */}
        {playerNumber &&
          !bombsUsed[playerNumber] && // Bomb not used by current player
          scores[playerNumber] < scores[playerNumber === 1 ? 2 : 1] && // Current player is behind in score
          !gameOver && ( // Game is not over
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
        {bombMode && " – Select 5x5 bomb center"} {/* Message when in bomb mode */}
      </p>
      {/* Display bomb error if any */}
      {bombError && <p className="app-message">{bombError}</p>}
      <p>
        Score 🔴 {scores[1]} | 🔵 {scores[2]}
      </p>

      {/* "Back to Lobby" button only shown when game is over */}
      {gameOver && (
        <button className="bomb-button" onClick={backToLobby}>
          Back to Lobby
        </button>
      )}

      <div
        className="grid"
        style={{
          // Dynamically set grid columns based on board width
          gridTemplateColumns: `repeat(${board[0]?.length || 0}, 40px)`,
        }}
      >
        {/* Render each tile in the board */}
        {board.flatMap((row, y) =>
          row.map((tile, x) => (
            <div
              key={`${x}-${y}`} // Unique key for each tile
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
