// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid"); // Ensure you have 'uuid' installed: npm install uuid

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com",
    methods: ["GET", "POST"],
    credentials: true, // It's good practice to explicitly include credentials for Socket.IO
  },
});

app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // your frontend
    credentials: true, // allow cookies
  })
);

// === Session middleware ===
// IMPORTANT: This uses the default in-memory session store, which will lose all sessions
// upon server restarts/deployments (common on Render).
app.use(
  session({
    secret: process.env.SESSION_SECRET, // Make sure SESSION_SECRET is set in Render env vars
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none", // Required for cross-site cookie transmission
      secure: true,	   // Must be true for HTTPS (Render provides HTTPS)
    },
  })
);

app.set('trust proxy', 1); // Crucial when deployed behind a load balancer (like Render)

const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID; // Ensure these are set in Render env vars
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Passport config ===
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID, // Ensure these are set in Render env vars
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback" // Your Render backend callback URL
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
    return cb(null, profile);
  }
));

// Passport Serialization/Deserialization
passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// === Authentication Routes ===
app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
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
      res.status(200).send("Logged out successfully");
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

// --- Game Constants ---
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;

// Global Game Data Structures (in-memory, not persistent)
let players = []; // Lobby players: { id: socket.id, name, number, inGame }
let games = {}; // Active games: gameId: { players: [player1, player2], board, scores, bombsUsed, turn, gameOver }

// Helper to generate a new Minesweeper board
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

// Helper for recursive reveal of blank areas
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

// Helper for bomb ability 5x5 reveal
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
  console.log(`Socket Connected: ${socket.id}`);

  socket.on("join-lobby", (name) => {
    if (!name) {
      socket.emit("join-error", "Invalid name");
      return;
    }
    const existingPlayerIndex = players.findIndex((p) => p.name === name);

    if (existingPlayerIndex !== -1) {
      const existingPlayer = players[existingPlayerIndex];

      if (existingPlayer.id === socket.id) {
        socket.emit("lobby-joined", name);
        existingPlayer.inGame = false;
        existingPlayer.number = null;
        console.log(`Player ${name} re-joined with same socket ID.`);
      } else {
        console.log(`Player ${name} joined with new socket ID, updating existing player.`);
        existingPlayer.id = socket.id;
        existingPlayer.inGame = false;
        existingPlayer.number = null;
        socket.emit("lobby-joined", name);
      }
    } else {
      players.push({ id: socket.id, name, number: null, inGame: false });
      socket.emit("lobby-joined", name);
      console.log(`New player ${name} joined lobby.`);
    }

    io.emit(
      "players-list",
      players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("leave-game", ({ gameId }) => {
    const leavingPlayer = players.find((p) => p.id === socket.id);
    if (!leavingPlayer) {
      console.log(`Player with ID ${socket.id} not found on leave-game.`);
      return;
    }

    leavingPlayer.inGame = false;
    leavingPlayer.number = null;
    console.log(`Player ${leavingPlayer.name} left game ${gameId}.`);

    const game = games[gameId];
    if (game) {
      game.players.forEach((p) => {
        if (p.id !== socket.id) {
          io.to(p.id).emit("opponent-left");
          const opponent = players.find((pl) => pl.id === p.id);
          if (opponent) {
            opponent.inGame = false;
            opponent.number = null;
          }
        }
      });
      delete games[gameId];
    }

    io.emit(
      "players-list",
      players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
    );
  });

  socket.on("invite-player", (targetId) => {
    const inviter = players.find((p) => p.id === socket.id);
    const invitee = players.find((p) => p.id === targetId);
    if (!inviter || !invitee) return;
    if (inviter.inGame || invitee.inGame) return;

    io.to(invitee.id).emit("game-invite", {
      fromId: inviter.id,
      fromName: inviter.name,
    });
  });

  socket.on("respond-invite", ({ fromId, accept }) => {
    const responder = players.find((p) => p.id === socket.id);
    const inviter = players.find((p) => p.id === fromId);
    if (!responder || !inviter) return;

    if (responder.inGame || inviter.inGame) {
      io.to(responder.id).emit("invite-rejected", { fromName: inviter.name, reason: "Already in another game" });
      io.to(inviter.id).emit("invite-rejected", { fromName: responder.name, reason: "Already in another game" });
      return;
    }

    if (accept) {
      const gameId = `${inviter.id}-${responder.id}`;
      const board = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

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

      io.emit(
        "players-list",
        players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
      );

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

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: responder.name });
    }
  });

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
      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    io.to(game.players[0].id).emit("board-update", game);
    io.to(game.players[1].id).emit("board-update", game);
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

    // --- NEW BOMB LOGIC ---
    // 1. Check if the bomb center is within the allowed 12x12 area (3rd line/col to 14th line/col)
    // Board is 0-indexed, so columns 2-13 and rows 2-13
    const MIN_COORD = 2; // For 3rd line/column
    const MAX_COORD_X = WIDTH - 3; // For 14th column (16-3 = 13)
    const MAX_COORD_Y = HEIGHT - 3; // For 14th line (16-3 = 13)

    if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
      console.log(`Bomb center (${x},${y}) out of bounds for 5x5 blast.`);
      // Optionally, send an error back to the client
      io.to(player.id).emit("bomb-error", "Bomb center must be within the 12x12 area.");
      return;
    }

    // 2. Check if all tiles in the 5x5 area are already revealed
    let allTilesRevealed = true;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const checkX = x + dx;
        const checkY = y + dy;
        // Ensure coordinates are within board limits (even though center is restricted, check individual tiles)
        if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) {
          if (!game.board[checkY][checkX].revealed) {
            allTilesRevealed = false;
            break;
          }
        } else {
            // This case should ideally not be hit if MIN/MAX_COORD_X/Y are correct for a 5x5 bomb
            // but good to be robust. If any tile is outside board, it's not "all revealed"
            allTilesRevealed = false;
            break;
        }
      }
      if (!allTilesRevealed) break;
    }

    if (allTilesRevealed) {
      console.log(`Bomb area at (${x},${y}) already fully revealed.`);
      // Optionally, send an error back to the client
      io.to(player.id).emit("bomb-error", "All tiles in the bomb area are already revealed.");
      return;
    }
    // --- END NEW BOMB LOGIC ---

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
    const idx = players.findIndex((p) => p.id === socket.id);
    if (idx !== -1) {
      const leavingPlayer = players[idx];
      console.log(`Player ${leavingPlayer.name} disconnected.`);
      if (leavingPlayer.inGame) {
        for (const gameId in games) {
          const game = games[gameId];
          if (game.players.some((p) => p.id === socket.id)) {
            game.players.forEach((p) => {
              if (p.id !== socket.id) {
                io.to(p.id).emit("opponent-left");
                const opponent = players.find((pl) => pl.id === p.id);
                if (opponent) {
                  opponent.inGame = false;
                  opponent.number = null;
                }
              }
            });
            delete games[gameId];
            break;
          }
        }
      }
      players.splice(idx, 1);
      io.emit(
        "players-list",
        players.filter((p) => !p.inGame).map((p) => ({ id: p.id, name: p.name }))
      );
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
