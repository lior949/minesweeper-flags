const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy; // <--- NEW IMPORT

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com",
    methods: ["GET", "POST"],
  },
});

app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // your frontend
    credentials: true, // allow cookies
  })
);

// === Session middleware ===
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none", // allow across ports
      secure: true,	
    },
  })
);

app.set('trust proxy', 1);

const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Passport config ===
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

passport.use(new FacebookStrategy({
    clientID: FACEBOOK_CLIENT_ID,
    clientSecret: FACEBOOK_CLIENT_SECRET,
    callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback", // Your Render backend callback URL
    profileFields: ['id', 'displayName', 'photos', 'email'] // Request more info if needed
  },
  function(accessToken, refreshToken, profile, cb) {
    // In a real app, you'd find or create a user in your DB here.
    // For now, we just pass the profile directly.
    return cb(null, profile);
  }
));

passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// === Routes ===
app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] }) // Request necessary scopes
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed", // Or your desired frontend failure URL
    successRedirect: "https://minesweeper-flags-frontend.onrender.com", // Your frontend success URL
  })
);

app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
  })
);

app.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.status(200).send("Logged out successfully"); // This is fine as is
    });
  });
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});

app.get("/me", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;

let players = []; // { id, name, number, inGame }
let games = {}; // gameId: { players: [player1, player2], board, scores, bombsUsed, turn, gameOver }

const generateBoard = () => {
  const board = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null,
    }))
  );

  let minesPlaced = 0;
  while (minesPlaced < MINES) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);
    if (!board[y][x].isMine) {
      board[y][x].isMine = true;
      minesPlaced++;
    }
  }

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (board[y][x].isMine) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < HEIGHT && nx >= 0 && nx < WIDTH) {
            if (board[ny][nx].isMine) count++;
          }
        }
      }
      board[y][x].adjacentMines = count;
    }
  }
  return board;
};

const revealRecursive = (board, x, y) => {
  const tile = board[y]?.[x];
  if (!tile || tile.revealed) return;
  tile.revealed = true;
  if (tile.adjacentMines === 0 && !tile.isMine) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) {
          revealRecursive(board, x + dx, y + dy);
        }
      }
    }
  }
};

const revealArea = (board, cx, cy, player, scores) => {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
        const tile = board[y][x];
        if (!tile.revealed) {
          if (tile.isMine) {
            tile.revealed = true;
            tile.owner = player;
            scores[player]++;
          } else {
            revealRecursive(board, x, y);
          }
        }
      }
    }
  }
};

const checkGameOver = (scores) => {
  return scores[1] >= 26 || scores[2] >= 26;
};

io.on("connection", (socket) => {
  // Authentication & lobby join
  socket.on("join-lobby", (name) => {
    if (!name) {
      socket.emit("join-error", "Invalid name");
      return;
    }
	 // Check if a player with this name already exists
    const existingPlayerIndex = players.findIndex((p) => p.name === name);

    if (existingPlayerIndex !== -1) {
      // A player with this name already exists
      const existingPlayer = players[existingPlayerIndex];

      if (existingPlayer.id === socket.id) {
        // Same player re-joining (e.g., page refresh without full disconnect)
        // No error, just confirm lobby joined.
        socket.emit("lobby-joined", name);
        // Ensure they are marked not in game if they were previously
        existingPlayer.inGame = false;
        existingPlayer.number = null;
        console.log(`Player ${name} re-joined with same socket ID.`);
      } else {
        // Player with this name exists but with a different socket ID
        // This implies an old connection or a new login for the same user.
        // Update the existing player's socket ID and status.
        console.log(`Player ${name} joined with new socket ID, updating existing player.`);
        existingPlayer.id = socket.id;
        existingPlayer.inGame = false; // Ensure they are in lobby, not in a stale game
        existingPlayer.number = null;
        socket.emit("lobby-joined", name);

        // Disconnect the old socket if it's still somehow active (optional, but good for cleanup)
        // This is tricky as we don't have a direct reference to the old socket object.
        // The 'disconnect' event on the old socket should handle its cleanup eventually.
      }
    } else {
      // New player
      players.push({ id: socket.id, name, number: null, inGame: false });
      socket.emit("lobby-joined", name);
      console.log(`New player ${name} joined lobby.`);
    }

    // Always emit the updated players list after joining/rejoining
    io.emit(
      "players-list",
      players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
    );
  });
  
  socket.on("leave-game", ({ gameId }) => {
    const game = games[gameId];
    if (game) {
      // Find the player leaving
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        // Remove the player from the game's player list
        game.players.splice(playerIndex, 1);
        console.log(`Player ${socket.id} left game ${gameId}. Players remaining: ${game.players.length}`);

        // If no players left, clean up the game
        if (game.players.length === 0) {
          delete games[gameId];
          console.log(`Game ${gameId} deleted as no players remain.`);
        } else {
          // Notify the remaining player if any
          const remainingPlayerSocketId = game.players[0].id;
          io.to(remainingPlayerSocketId).emit("opponent-left");
        }
      }
    }
    // Also remove player from general lobby list if they were there
    // This depends on how your `players` array for the lobby is managed.
    players = players.filter(p => p.id !== socket.id);
    io.emit("players-list", players); // Update lobby list
  });

  socket.on("invite-player", (targetId) => {
    const inviter = players.find((p) => p.id === socket.id);
    const invitee = players.find((p) => p.id === targetId);
    if (!inviter || !invitee) return;
    if (inviter.inGame || invitee.inGame) return;

    // Send invite to invitee
    io.to(invitee.id).emit("game-invite", {
      fromId: inviter.id,
      fromName: inviter.name,
    });
  });

  socket.on("respond-invite", ({ fromId, accept }) => {
    const responder = players.find((p) => p.id === socket.id);
    const inviter = players.find((p) => p.id === fromId);
    if (!responder || !inviter) return;

    if (accept) {
      // Start a new game
      const gameId = `${inviter.id}-${responder.id}`;
      const board = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

      // Assign players numbers and mark inGame
      inviter.number = 1;
      inviter.inGame = true;
      responder.number = 2;
      responder.inGame = true;

      games[gameId] = {
        players: [inviter, responder],
        board,
        scores,
        bombsUsed,
        turn,
        gameOver,
      };

      // Notify players game started with initial state
      [inviter, responder].forEach((p) => {
        io.to(p.id).emit("game-start", {
          playerNumber: p.number,
          board,
          turn,
          scores,
          bombsUsed,
          gameOver,
          opponentName:
            p.id === inviter.id ? responder.name : inviter.name,
          gameId,
        });
      });

      // Update lobby player list (remove those inGame)
      io.emit(
        "players-list",
        players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
      );
    } else {
      // Invite rejected
      io.to(fromId).emit("invite-rejected", { fromName: responder.name });
    }
  });

  // Handle game actions
  socket.on("tile-click", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const player = game.players.find((p) => p.id === socket.id);
    if (!player || player.number !== game.turn) return;

    const tile = game.board[y][x];
    if (tile.revealed) return;

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      game.scores[player.number]++;
      if (checkGameOver(game.scores)) game.gameOver = true;
    } else {
      const isBlankTile = tile.adjacentMines === 0;
      const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0;

      if (isBlankTile && noFlagsRevealedYet) {
        console.log(`Player ${player.name} (${player.id}) hit a blank tile before any flags were revealed. Restarting game ${gameId}.`);

        // Reset game state properties within the existing game object
        game.board = generateBoard(); // Generate a brand new board
        game.scores = { 1: 0, 2: 0 }; // Reset scores
        game.bombsUsed = { 1: false, 2: false }; // Reset bomb usage
        game.turn = 1; // Reset turn to player 1
        game.gameOver = false; // Game is no longer over

        // Prepare full data objects for each player to "restart" their game view
        const player1Data = {
          gameId: game.gameId,
          playerNumber: 1,
          board: game.board,
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          opponentName: game.players[1] ? game.players[1].name : "Opponent" // Get opponent name
        };

        const player2Data = {
          gameId: game.gameId,
          playerNumber: 2,
          board: game.board,
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          opponentName: game.players[0].name // Get opponent name
        };

        // Emit "game-restarted" with full game data for each specific player
        io.to(game.players[0].id).emit("game-restarted", player1Data);
        if (game.players[1]) {
            io.to(game.players[1].id).emit("game-restarted", player2Data);
        }

        // Add a log to ensure the game object itself is still valid on the server
        console.log(`Game ${gameId} after restart: Players ${game.players[0].name}, ${game.players[1] ? game.players[1].name : 'N/A'}`);

        return; // Stop further processing for this click
      }

      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    // Always emit board update after a valid click (unless game was restarted)
    // The "game-restarted" event above will handle sending the new board state
    // We only emit board-update if the game was NOT restarted by this click
    if (!isBlankTile || !noFlagsRevealedYet) { // Only emit if restart logic was NOT triggered
        io.to(game.players[0].id).emit("board-update", game);
        if (game.players[1]) {
            io.to(game.players[1].id).emit("board-update", game);
        }
    }
  });


  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const player = game.players.find((p) => p.id === socket.id);
    if (!player || game.bombsUsed[player.number]) return;

    io.to(player.id).emit("wait-bomb-center");
  });

  socket.on("bomb-center", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const player = game.players.find((p) => p.id === socket.id);
    if (!player || game.bombsUsed[player.number]) return;

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    io.to(game.players[0].id).emit("board-update", game);
    io.to(game.players[1].id).emit("board-update", game);
  });

  socket.on("restart-game", ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    if (!game.players.find((p) => p.id === socket.id)) return;

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;

    io.to(game.players[0].id).emit("board-update", game);
    io.to(game.players[1].id).emit("board-update", game);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // When a user disconnects, ensure they are removed from any game
    // and the lobby. Iterate through games to check.
    for (const id in games) {
        const game = games[id];
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            game.players.splice(playerIndex, 1);
            if (game.players.length === 0) {
                delete games[id];
                console.log(`Game ${id} deleted on disconnect.`);
            } else {
                io.to(game.players[0].id).emit("opponent-left");
            }
        }
    }
    // Remove from lobby player list
    players = players.filter(p => p.id !== socket.id);
    io.emit("players-list", players); // Update lobby list
  });

const PORT = process.env.PORT || 3001; // 3001 for local dev, Render provides PORT
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
