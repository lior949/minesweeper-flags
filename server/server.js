// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid"); // For generating unique game IDs

const app = express();
const server = http.createServer(app);

// New global data structures (simple in-memory for this version)
const userSocketMap = {}; // Maps userId to current socket.id
const userGameMap = {};   // Maps userId to current gameId

// Configure CORS for Express
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true,
  })
);

// Configure Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// === Environment Variables for OAuth ===
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

app.set('trust proxy', 1); // Crucial for Render

// === Express Session Middleware (In-memory store) ===
app.use(
  session({
    secret: process.env.SESSION_SECRET || "super-secret-fallback-key-for-dev",
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "none",
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24
    },
  })
);

// === Passport Configuration ===
app.use(passport.initialize());
app.use(passport.session());

// Passport Google Strategy
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  console.log("Google Auth Profile:", profile.displayName, profile.id);
  done(null, profile.id); // Store profile.id (Google ID) in session
}));

// Passport Facebook Strategy
passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID,
  clientSecret: FACEBOOK_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  console.log("Facebook Auth Profile:", profile.displayName, profile.id);
  cb(null, profile.id);
}));


// Passport Serialization/Deserialization
passport.serializeUser((userId, done) => {
  console.log("serializeUser:", userId);
  done(null, userId);
});

passport.deserializeUser((userId, done) => {
  console.log("deserializeUser:", userId);
  // This version returns just the userId, not an object with displayName
  done(null, userId);
});


// === Authentication Routes ===
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.get("/auth/google/callback", passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
}));

app.get("/auth/facebook", passport.authenticate("facebook", { scope: ['public_profile'] }));
app.get("/auth/facebook/callback", passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com",
    successRedirect: "https://minesweeper-flags-frontend.onrender.com",
}));

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => {
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          domain: '.onrender.com',
          secure: true,
          sameSite: 'none'
      });
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

// This /me endpoint will return just the ID, as deserializeUser returns ID
app.get("/me", (req, res) => {
  console.log("------------------- /me Request Received -------------------");
  console.log("Is Authenticated (req.isAuthenticated()):", req.isAuthenticated());
  console.log("User in session (req.user):", req.user);
  console.log("Session ID (req.sessionID):", req.sessionID);
  console.log("Session object (req.session):", req.session);

  if (req.isAuthenticated()) {
    // req.user here is just the userId string
    res.json({ user: { id: req.user, displayName: `User_${req.user.substring(0, 8)}` } }); // Mock display name
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
  console.log("------------------------------------------------------------");
});

// --- Game Logic ---
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;
let players = []; // Lobby players: { id: socket.id, userId, name }
let games = {};

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
const revealRecursive = (board, x, y) => {
    if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || board[y][x].revealed) {
      return;
    }
    const tile = board[y][x];
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
const revealArea = (board, cx, cy, playerNumber, scores) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
          const tile = board[y][x];
          if (!tile.revealed) {
            if (tile.isMine) {
              tile.revealed = true;
              tile.owner = playerNumber;
              scores[playerNumber]++;
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

// === Socket.IO Connection and Game Events (Simpler handling) ===
io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // This version relies on socket.request.session.passport.user directly
  // It might be undefined initially if the socket connects before the session is fully set up
  // or if the in-memory session store is reset.
  const userIdFromSession = socket.request.session?.passport?.user || null;
  if (userIdFromSession) {
      console.log(`User ${userIdFromSession} (re)connected. Socket ID: ${socket.id}`);
      userSocketMap[userIdFromSession] = socket.id; // Update socket ID on reconnect
      // In this simpler version, we don't proactively re-send game state on reconnect
      // The frontend would implicitly go to lobby if gameId is null.
  } else {
      console.log(`Unauthenticated socket ${socket.id} connected.`);
  }

  socket.on("join-lobby", (name) => {
    // Get userId directly here.
    const userId = socket.request.session?.passport?.user || null;
    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby. Please login.");
        console.warn(`Unauthenticated socket ${socket.id} tried to join lobby. Rejecting.`);
        return;
    }

    // This is the place where `name` (from client) is stored with `userId`
    // Ensure player isn't duplicated (basic check)
    players = players.filter(p => p.userId !== userId);
    players.push({ id: socket.id, userId: userId, name: name });

    console.log(`Player ${name} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined");
    // In this older version, we don't filter lobby players by game status
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));
  });

  socket.on("invite-player", (targetSocketId) => {
    const inviterPlayer = players.find(p => p.id === socket.id);
    const invitedPlayer = players.find(p => p.id === targetSocketId);

    if (inviterPlayer && invitedPlayer) {
      io.to(invitedPlayer.id).emit("game-invite", {
        fromId: inviterPlayer.id,
        fromName: inviterPlayer.name,
      });
    }
  });

  socket.on("respond-invite", ({ fromId, accept }) => {
    const respondingPlayer = players.find(p => p.id === socket.id);
    const inviterPlayer = players.find(p => p.id === fromId);

    if (!respondingPlayer || !inviterPlayer) return;

    if (accept) {
      const gameId = uuidv4();
      const newBoard = generateBoard();
      const game = {
        gameId,
        board: newBoard,
        players: [
          { userId: inviterPlayer.userId, name: inviterPlayer.name, number: 1, socketId: inviterPlayer.id },
          { userId: respondingPlayer.userId, name: respondingPlayer.name, number: 2, socketId: respondingPlayer.id },
        ],
        turn: 1,
        scores: { 1: 0, 2: 0 },
        bombsUsed: { 1: false, 2: false },
        gameOver: false,
      };
      games[gameId] = game;

      // In this version, we start tracking userGameMap on game start
      userGameMap[inviterPlayer.userId] = gameId;
      userGameMap[respondingPlayer.userId] = gameId;

      // Remove players from lobby list after starting game
      players = players.filter(p => p.id !== inviterPlayer.id && p.id !== respondingPlayer.id);
      io.emit("players-list", players.map(p => ({ id: p.id, name: p.name }))); // Send updated lobby list

      io.to(inviterPlayer.id).emit("game-start", {
        gameId: game.gameId, playerNumber: 1, board: game.board, turn: game.turn, scores: game.scores,
        bombsUsed: game.bombsUsed, gameOver: game.gameOver, opponentName: respondingPlayer.name,
      });
      io.to(respondingPlayer.id).emit("game-start", {
        gameId: game.gameId, playerNumber: 2, board: game.board, turn: game.turn, scores: game.scores,
        bombsUsed: game.bombsUsed, gameOver: game.gameOver, opponentName: inviterPlayer.name,
      });
    } else {
      io.to(fromId).emit("invite-rejected", { fromName: respondingPlayer.name });
    }
  });

  socket.on("tile-click", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const userId = socket.request.session?.passport?.user || null;
    const player = game.players.find((p) => p.userId === userId);
    if (!player || player.number !== game.turn) return;

    // Update player's socketId in game object with current socket.id (basic reconnection support)
    player.socketId = socket.id;

    const tile = game.board[y][x];
    if (tile.revealed) return;

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      game.scores[player.number]++;
      if (checkGameOver(game.scores)) game.gameOver = true;
    } else {
      // No special blank-tile-first game restart logic in this version
      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1;
    }

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", game);
    });
  });

  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const userId = socket.request.session?.passport?.user || null;
    const player = game.players.find((p) => p.userId === userId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Update socket ID

    io.to(player.socketId).emit("wait-bomb-center");
  });

  socket.on("bomb-center", ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const userId = socket.request.session?.passport?.user || null;
    const player = game.players.find((p) => p.userId === userId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Update socket ID

    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    game.players.forEach(p => {
        if(p.socketId) io.to(p.socketId).emit("board-update", game);
    });
  });

  // No specific "game-restarted" event handling in this version for blank-tile.
  // Manual restart might not be implemented or have simpler behavior.

  socket.on("leave-game", ({ gameId }) => {
    const game = games[gameId];
    const userId = socket.request.session?.passport?.user || null;

    if (game && userId) {
      const playerIndex = game.players.findIndex(p => p.userId === userId);
      if (playerIndex !== -1) {
        delete userGameMap[userId]; // Remove user from game map
        game.players.splice(playerIndex, 1);

        if (game.players.length === 0) {
          delete games[gameId];
          console.log(`Game ${gameId} deleted as no players remain.`);
        } else {
          const remainingPlayer = game.players[0];
          if (remainingPlayer && remainingPlayer.socketId) {
             io.to(remainingPlayer.socketId).emit("opponent-left");
          }
        }
      }
    }
    // Re-add player to lobby list if they were logged in
    if (userId) {
        players = players.filter(p => p.userId !== userId); // Remove existing entry
        const playerName = socket.request.session?.userDisplayName || `User_${userId.substring(0, 8)}`; // Get name from session if stored
        players.push({ id: socket.id, userId: userId, name: playerName });
    }
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));
  });


  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const disconnectedUserId = socket.request.session?.passport?.user || null;

    if (disconnectedUserId) {
        delete userSocketMap[disconnectedUserId];
    }

    // Remove from lobby player list (by socket.id or userId if known)
    players = players.filter(p => p.id !== socket.id && p.userId !== disconnectedUserId);
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));

    // Check if the disconnected user was in a game
    for (const id in games) {
        const game = games[id];
        const playerIndex = game.players.findIndex(p => p.socketId === socket.id || (disconnectedUserId && p.userId === disconnectedUserId));
        if (playerIndex !== -1) {
            if (game.players[playerIndex].userId) {
                delete userGameMap[game.players[playerIndex].userId];
            }
            game.players.splice(playerIndex, 1);
            if (game.players.length === 0) {
                delete games[id];
            } else {
                const remainingPlayer = game.players[0];
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                }
            }
        }
    }
  });

});

// --- Server Startup ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
