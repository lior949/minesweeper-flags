// server.js

const express = require("express");
const fetch = require('node-fetch');
const router = express.Router();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;
const { v4: uuidv4 } = require("uuid");

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { Firestore } = require('@google-cloud/firestore');

// --- NEW: Corrected Firestore Session Store Imports ---
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
app.use(express.json());
app.set('trust proxy', 1);
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID, Guest ID)
const userGameMap = {};   // Maps userId to the gameId they are currently in

// Configure CORS for Express
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true, // Allow cookies to be sent cross-origin
  })
);

// Firebase Admin SDK initialization (if not already initialized)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      // databaseURL: 'https://<DATABASE_NAME>.firebaseio.com' // Optional: if using Realtime Database
    });
  } catch (error) {
    console.error("Firebase admin initialization error:", error);
  }
}

const db = getFirestore();
const GAMES_COLLECTION_PATH = 'games'; // Centralized collection path

// Configure session middleware
const sessionMiddleware = session({
  store: new FirestoreStore({
    dataset: new Firestore(),
    kind: 'express-sessions',
  }),
  secret: process.env.SESSION_SECRET || "your_secret_key", // Use environment variable for secret
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'Lax', // Or 'None' if cross-site, with secure: true
  },
});
app.use(sessionMiddleware);

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization/deserialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
      scope: ["profile"],
      state: true, // Enable state parameter to prevent CSRF
    },
    (accessToken, refreshToken, profile, done) => {
      // In a real app, you would find or create a user in your database
      const user = {
        id: profile.id,
        name: profile.displayName,
        provider: 'google'
      };
      return done(null, user);
    }
  )
);

// Facebook OAuth Strategy
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: "/auth/facebook/callback",
      profileFields: ['id', 'displayName'],
      state: true, // Enable state parameter to prevent CSRF
    },
    (accessToken, refreshToken, profile, done) => {
      const user = {
        id: profile.id,
        name: profile.displayName,
        provider: 'facebook'
      };
      return done(null, user);
    }
  )
);

// Google Auth Routes
app.get(
  "/auth/google",
  (req, res, next) => {
    // Store the client's redirect URL in session if needed
    req.session.redirectTo = req.query.redirectTo;
    passport.authenticate("google")(req, res, next);
  }
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login", // Redirect to a login page on failure
  }),
  (req, res) => {
    // On successful authentication, redirect to a client-side route that handles post-login
    // For example, redirect to a page that messages the opener or closes the popup
    const redirectUrl = req.session.redirectTo || 'https://minesweeper-flags-frontend.onrender.com/auth-success'; // Default fallback
    delete req.session.redirectTo; // Clean up session
    res.redirect(redirectUrl);
  }
);

// Facebook Auth Routes
app.get(
  "/auth/facebook",
  (req, res, next) => {
    req.session.redirectTo = req.query.redirectTo;
    passport.authenticate("facebook")(req, res, next);
  }
);

app.get(
  "/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "/login",
  }),
  (req, res) => {
    const redirectUrl = req.session.redirectTo || 'https://minesweeper-flags-frontend.onrender.com/auth-success';
    delete req.session.redirectTo;
    res.redirect(redirectUrl);
  }
);

// API endpoint to check authentication status and provide user info
app.get("/api/auth-status", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      isAuthenticated: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        provider: req.user.provider,
      },
    });
  } else {
    res.json({ isAuthenticated: false });
  }
});

// API endpoint for guest login
app.post("/api/guest-login", (req, res) => {
  const { name, guestId } = req.body;
  if (!name || !guestId) {
    return res.status(400).json({ message: "Name and guestId are required for guest login." });
  }

  const user = {
    id: `guest-${guestId}`, // Prefix guest IDs
    name: name,
    provider: 'guest'
  };

  req.login(user, (err) => {
    if (err) {
      console.error("Guest login error:", err);
      return res.status(500).json({ message: "Failed to log in as guest." });
    }
    res.json({ message: "Guest login successful", user });
  });
});

// API endpoint for logout
app.get("/api/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destruction error:", err);
        return next(err);
      }
      res.clearCookie('connect.sid'); // Clear session cookie
      res.json({ message: "Logged out successfully" });
    });
  });
});

// --- Minesweeper Game Logic ---

// Global Game Data Structures
let players = []; // Lobby players: [{ id: socket.id, userId, name }]
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], observers: [{userId, name, socketId}], board, scores, bombsUsed, turn, gameOver, lastClickedTile }

// Helper to generate a new Minesweeper board
function generateBoard(size, numMines) {
    const board = Array(size)
        .fill(0)
        .map(() =>
            Array(size)
                .fill(0)
                .map(() => ({
                    isMine: false,
                    revealed: false,
                    adjacentMines: 0,
                    owner: null, // To track which player revealed the tile
                }))
        );

    let minesPlaced = 0;
    while (minesPlaced < numMines) {
        const x = Math.floor(Math.random() * size);
        const y = Math.floor(Math.random() * size);

        if (!board[y][x].isMine) {
            board[y][x].isMine = true;
            minesPlaced++;
        }
    }

    // Calculate adjacent mines
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!board[y][x].isMine) {
                let count = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (
                            nx >= 0 &&
                            nx < size &&
                            ny >= 0 &&
                            ny < size &&
                            board[ny][nx].isMine
                        ) {
                            count++;
                        }
                    }
                }
                board[y][x].adjacentMines = count;
            }
        }
    }
    return board;
}

// Attach Socket.IO to the Express session
const io = new Server(server, {
  cors: {
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true,
  },
});

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Authenticate socket and retrieve user info from session
  let userId = null;
  let userName = "Guest"; // Default name
  if (socket.request.session?.passport?.user) {
    userId = socket.request.session.passport.user.id;
    userName = socket.request.session.passport.user.name;
    console.log(`Socket ${socket.id} authenticated for user ${userName} (${userId})`);
    userSocketMap[userId] = socket.id; // Map userId to current socketId
  } else {
    console.log(`Socket ${socket.id} connected as unauthenticated.`);
    // Client should handle guest login via API first
  }

  // Confirm connection and send user data to client for lobby
  socket.on("join-lobby", () => {
    if (!userId) { // If user not yet identified (e.g., waiting for guest login)
      socket.emit("authentication-pending");
      return;
    }

    // Add or update player in the lobby list
    const existingPlayerIndex = players.findIndex(p => p.userId === userId);
    if (existingPlayerIndex > -1) {
      players[existingPlayerIndex].id = socket.id; // Update socket ID on reconnection
      players[existingPlayerIndex].lastSeen = Date.now();
    } else {
      players.push({ id: socket.id, userId, name: userName, lastSeen: Date.now() });
    }

    io.emit("update-player-list", players.filter(p => p.id !== socket.id)); // Send updated list to all
    socket.emit("lobby-joined", userName);
    console.log(`User ${userName} (${userId}) joined lobby. Total players: ${players.length}`);

    // If user was in a game, reconnect them
    if (userGameMap[userId]) {
        const gameId = userGameMap[userId];
        let game = games[gameId]; // Try to get from in-memory first

        if (!game) { // If not in memory, try to load from Firestore
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists) {
                    const gameData = doc.data();
                    if (gameData.status === 'active' || gameData.status === 'waiting_for_resume') {
                        const deserializedBoard = JSON.parse(gameData.board);

                        // Reconstruct in-memory game object
                        game = {
                            gameId: gameData.gameId,
                            board: deserializedBoard,
                            scores: gameData.scores || { 1: 0, 2: 0 },
                            bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
                            turn: gameData.turn,
                            gameOver: gameData.gameOver,
                            lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null },
                            players: [], // Will be populated with proper player objects
                            observers: [] // Initialize observers for reloaded game
                        };
                        // Add to in-memory games list
                        games[gameId] = game;

                        // Add players to game.players array if not already present from memory
                        // Ensure players in 'game.players' have current socket IDs
                        const player1Data = players.find(p => p.userId === gameData.player1_userId);
                        const player2Data = players.find(p => p.userId === gameData.player2_userId);

                        if (player1Data) game.players.push({ ...player1Data, number: 1, socketId: userSocketMap[player1Data.userId] });
                        if (player2Data) game.players.push({ ...player2Data, number: 2, socketId: userSocketMap[player2Data.userId] });

                        // Join game room
                        socket.join(gameId);

                        // Determine current player's number for game-start event
                        const currentPlayerInGame = game.players.find(p => p.userId === userId);

                        if (currentPlayerInGame) {
                            console.log(`User ${userName} (${userId}) rejoining game ${gameId} as Player ${currentPlayerInGame.number}.`);
                            io.to(currentPlayerInGame.socketId).emit("game-start", {
                                gameId: game.gameId,
                                playerNumber: currentPlayerInGame.number,
                                board: JSON.stringify(game.board),
                                turn: game.turn,
                                scores: game.scores,
                                bombsUsed: game.bombsUsed,
                                gameOver: game.gameOver,
                                lastClickedTile: game.lastClickedTile,
                                opponentName: game.players.find(p => p.userId !== userId)?.name || "Opponent"
                            });

                            // Notify opponent if they are active
                            const opponentPlayer = game.players.find(p => p.userId !== userId);
                            if (opponentPlayer && opponentPlayer.socketId && io.sockets.sockets.has(opponentPlayer.socketId)) {
                                io.to(opponentPlayer.socketId).emit("opponent-reconnected");
                            }
                        } else {
                            // This scenario means userId is in userGameMap but not in game.players.
                            // Could be an observer, or a stale entry. If an observer, handle here.
                            const existingObserver = game.observers.find(o => o.userId === userId);
                            if (existingObserver) {
                                existingObserver.socketId = socket.id; // Update socket ID
                                socket.join(gameId);
                                console.log(`User ${userName} (${userId}) rejoining game ${gameId} as Observer.`);
                                socket.emit("game-start", {
                                    gameId: game.gameId,
                                    playerNumber: null, // Observers don't have a player number
                                    board: JSON.stringify(game.board),
                                    turn: game.turn,
                                    scores: game.scores,
                                    bombsUsed: game.bombsUsed,
                                    gameOver: game.gameOver,
                                    lastClickedTile: game.lastClickedTile,
                                    opponentName: game.players[0] && game.players[1] ? `${game.players[0].name} vs ${game.players[1].name}` : "Players",
                                    isObserver: true
                                });
                            } else {
                                console.warn(`User ${userName} (${userId}) was mapped to game ${gameId} but not found as player or observer. Clearing map.`);
                                delete userGameMap[userId];
                            }
                        }

                    } else {
                        console.log(`Game ${gameId} is not active or waiting for resume. Clearing userGameMap for ${userId}.`);
                        delete userGameMap[userId]; // Clear map if game is not resumable
                    }
                } else {
                    console.log(`Game ${gameId} not found in Firestore. Clearing userGameMap for ${userId}.`);
                    delete userGameMap[userId]; // Clear map if game not found
                }
            }).catch(error => {
                console.error("Error loading game from Firestore on reconnect:", error);
                delete userGameMap[userId]; // Clear map on error
            });
        } else { // Game found in memory
            socket.join(gameId);
            const currentPlayerInGame = game.players.find(p => p.userId === userId);

            if (currentPlayerInGame) {
                console.log(`User ${userName} (${userId}) rejoining game ${gameId} as Player ${currentPlayerInGame.number} (in-memory).`);
                io.to(currentPlayerInGame.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: currentPlayerInGame.number,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    lastClickedTile: game.lastClickedTile,
                    opponentName: game.players.find(p => p.userId !== userId)?.name || "Opponent"
                });
                const opponentPlayer = game.players.find(p => p.userId !== userId);
                if (opponentPlayer && opponentPlayer.socketId && io.sockets.sockets.has(opponentPlayer.socketId)) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected");
                }
            } else {
                const existingObserver = game.observers.find(o => o.userId === userId);
                if (existingObserver) {
                    existingObserver.socketId = socket.id; // Update socket ID
                    socket.join(gameId);
                    console.log(`User ${userName} (${userId}) rejoining game ${gameId} as Observer (in-memory).`);
                    socket.emit("game-start", {
                        gameId: game.gameId,
                        playerNumber: null,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: game.players[0] && game.players[1] ? `${game.players[0].name} vs ${game.players[1].name}` : "Players",
                        isObserver: true
                    });
                } else {
                     console.warn(`User ${userName} (${userId}) was mapped to game ${gameId} but not found as player or observer in memory. Clearing map.`);
                     delete userGameMap[userId];
                }
            }
        }
    }
  });


  socket.on("find-game", () => {
    // Basic matchmaking: find a player waiting in lobby
    const waitingPlayer = players.find(
      (p) => p.id !== socket.id && !userGameMap[p.userId] // Ensure not self and not in a game
    );

    if (waitingPlayer) {
      // Found an opponent, start a new game
      const gameId = uuidv4();
      const boardSize = 15;
      const numMines = 30;
      const initialBoard = generateBoard(boardSize, numMines);

      const player1 = { id: waitingPlayer.id, userId: waitingPlayer.userId, name: waitingPlayer.name, number: 1 };
      const player2 = { id: socket.id, userId: userId, name: userName, number: 2 };

      const game = {
        gameId: gameId,
        players: [player1, player2],
        observers: [], // Initialize observers array
        board: initialBoard,
        scores: { 1: 0, 2: 0 },
        bombsUsed: { 1: false, 2: false },
        turn: 1, // Player 1 starts
        gameOver: false,
        lastClickedTile: { 1: null, 2: null }
      };
      games[gameId] = game; // Store game in memory

      userGameMap[player1.userId] = gameId;
      userGameMap[player2.userId] = gameId;

      // Join game rooms
      io.to(player1.id).socketsJoin(gameId);
      io.to(player2.id).socketsJoin(gameId);

      // Save new game to Firestore
      db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
          gameId: gameId,
          board: JSON.stringify(game.board),
          player1_userId: player1.userId,
          player1_name: player1.name,
          player2_userId: player2.userId,
          player2_name: player2.name,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          turn: game.turn,
          gameOver: game.gameOver,
          lastClickedTile: game.lastClickedTile,
          status: 'active', // Mark as active
          lastUpdated: Timestamp.now(),
          playerIds: [player1.userId, player2.userId] // Array for easy querying
      }).then(() => {
          console.log(`Game ${gameId} saved to Firestore.`);
      }).catch(error => {
          console.error("Error saving new game to Firestore:", error);
      });

      // Emit game-start to both players
      io.to(player1.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 1,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        opponentName: player2.name,
      });
      io.to(player2.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 2,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        opponentName: player1.name,
      });

      io.emit("update-player-list", players.filter(p => p.id !== socket.id && p.id !== waitingPlayer.id)); // Update lobby player list
      console.log(`Game ${gameId} started between ${player1.name} and ${player2.name}`);

    } else {
      socket.emit("no-opponent-found");
      console.log(`No opponent found for ${userName} (${userId}).`);
    }
  });


  socket.on("start-game", async (opponentSocketId) => {
    const player1 = players.find(p => p.id === socket.id);
    const player2 = players.find(p => p.id === opponentSocketId);

    if (!player1 || !player2) {
      socket.emit("error-message", "Player(s) not found for game start.");
      return;
    }

    // Ensure neither player is already in a game
    if (userGameMap[player1.userId] || userGameMap[player2.userId]) {
        socket.emit("error-message", "One or both players are already in a game.");
        return;
    }

    const gameId = uuidv4();
    const boardSize = 15;
    const numMines = 30;
    const initialBoard = generateBoard(boardSize, numMines);

    const player1InGame = { id: player1.id, userId: player1.userId, name: player1.name, number: 1 };
    const player2InGame = { id: player2.id, userId: player2.userId, name: player2.name, number: 2 };

    const game = {
      gameId: gameId,
      players: [player1InGame, player2InGame],
      observers: [], // Initialize observers array
      board: initialBoard,
      scores: { 1: 0, 2: 0 },
      bombsUsed: { 1: false, 2: false },
      turn: 1, // Player 1 starts
      gameOver: false,
      lastClickedTile: { 1: null, 2: null }
    };
    games[gameId] = game; // Store game in memory

    userGameMap[player1.userId] = gameId;
    userGameMap[player2.userId] = gameId;

    // Join game rooms
    io.to(player1.id).socketsJoin(gameId);
    io.to(player2.id).socketsJoin(gameId);

    // Save new game to Firestore
    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId: gameId,
            board: JSON.stringify(game.board),
            player1_userId: player1.userId,
            player1_name: player1.name,
            player2_userId: player2.userId,
            player2_name: player2.name,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            status: 'active', // Mark as active
            lastUpdated: Timestamp.now(),
            playerIds: [player1.userId, player2.userId] // Array for easy querying
        });
        console.log(`Game ${gameId} saved to Firestore.`);
    } catch (error) {
        console.error("Error saving new game to Firestore:", error);
    }

    // Emit game-start to both players
    io.to(player1.id).emit("game-start", {
      gameId: game.gameId,
      playerNumber: 1,
      board: JSON.stringify(game.board),
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      opponentName: player2.name,
    });
    io.to(player2.id).emit("game-start", {
      gameId: game.gameId,
      playerNumber: 2,
      board: JSON.stringify(game.board),
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      opponentName: player1.name,
    });

    // Update lobby player list (remove players who started game)
    io.emit("update-player-list", players.filter(p => p.id !== player1.id && p.id !== player2.id));
    console.log(`Game ${gameId} started between ${player1.name} and ${player2.name} via invite.`);
  });


  socket.on("send-invite", (targetSocketId) => {
    const senderPlayer = players.find(p => p.id === socket.id);
    const targetPlayer = players.find(p => p.id === targetSocketId);

    if (senderPlayer && targetPlayer) {
      if (userGameMap[senderPlayer.userId] || userGameMap[targetPlayer.userId]) {
          socket.emit("error-message", "You or your invited opponent are already in a game.");
          return;
      }
      io.to(targetSocketId).emit("receive-invite", {
        from: senderPlayer.name,
        fromSocketId: senderPlayer.id,
        fromUserId: senderPlayer.userId
      });
      socket.emit("invite-sent", targetPlayer.name);
      console.log(`Invite sent from ${senderPlayer.name} to ${targetPlayer.name}`);
    } else {
      socket.emit("error-message", "Could not send invite. Player not found.");
    }
  });

  socket.on("decline-invite", (fromSocketId) => {
    const senderPlayer = players.find(p => p.id === fromSocketId);
    const declinerPlayer = players.find(p => p.id === socket.id);
    if (senderPlayer && declinerPlayer) {
      io.to(fromSocketId).emit("invite-declined", declinerPlayer.name);
      console.log(`${declinerPlayer.name} declined invite from ${senderPlayer.name}`);
    }
  });


  socket.on("tile-click", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game) {
      socket.emit("error-message", "Game not found.");
      return;
    }

    const currentPlayer = game.players.find(p => p.socketId === socket.id);
    if (!currentPlayer || currentPlayer.number !== game.turn || game.gameOver) {
      socket.emit("error-message", "It's not your turn, game is over, or you are not a player in this game.");
      return;
    }

    const tile = game.board[y][x];

    if (tile.revealed) {
      socket.emit("error-message", "Tile already revealed.");
      return;
    }

    let scoreChange = 0;
    if (tile.isMine) {
        // Player clicks a mine, they lose a point (or mine is revealed for opponent)
        // For simplicity, let's say clicking own mine is -1 point.
        scoreChange = -1;
    } else {
        // Non-mine tile, score based on adjacent mines (e.g., higher adj mines, higher score)
        scoreChange = 1 + tile.adjacentMines;
    }

    tile.revealed = true;
    tile.owner = currentPlayer.number; // Mark tile with owner

    game.scores[currentPlayer.number] += scoreChange;

    // Update last clicked tile
    game.lastClickedTile[currentPlayer.number] = { x, y };

    // Check for game over (e.g., all non-mine tiles revealed, or score limit)
    let allNonMineTilesRevealed = true;
    for (let row of game.board) {
        for (let t of row) {
            if (!t.isMine && !t.revealed) {
                allNonMineTilesRevealed = false;
                break;
            }
        }
        if (!allNonMineTilesRevealed) break;
    }

    if (allNonMineTilesRevealed) {
        game.gameOver = true;
        // Determine winner
        const winner = game.scores[1] > game.scores[2] ? 1 : game.scores[2] > game.scores[1] ? 2 : 0; // 0 for tie
        io.to(gameId).emit("game-over", { winner, scores: game.scores });

        // Update Firestore status to 'completed'
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            scores: game.scores,
            board: JSON.stringify(game.board), // Save final board state
            lastClickedTile: game.lastClickedTile,
            turn: game.turn,
            gameOver: game.gameOver,
            status: 'completed',
            lastUpdated: Timestamp.now()
        });
        console.log(`Game ${gameId} ended. Winner: Player ${winner}. Final scores: ${game.scores[1]} | ${game.scores[2]}`);
    } else {
        // Switch turn
        game.turn = currentPlayer.number === 1 ? 2 : 1;

        // Save game state to Firestore (important for persistence)
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            scores: game.scores,
            board: JSON.stringify(game.board),
            lastClickedTile: game.lastClickedTile,
            turn: game.turn,
            gameOver: game.gameOver,
            lastUpdated: Timestamp.now()
        });
    }

    // Emit board update to both players and observers in the game room
    io.to(gameId).emit("board-update", {
      gameId: game.gameId,
      board: JSON.stringify(game.board),
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
    });
  });

  socket.on("use-bomb", async ({ gameId, playerNumber }) => {
    const game = games[gameId];
    if (!game) {
        socket.emit("error-message", "Game not found for bomb use.");
        return;
    }

    const currentPlayer = game.players.find(p => p.socketId === socket.id);
    if (!currentPlayer || currentPlayer.number !== playerNumber || game.gameOver) {
        socket.emit("error-message", "Invalid bomb request: Not your turn, game over, or not a player.");
        return;
    }

    if (game.bombsUsed[playerNumber]) {
        socket.emit("error-message", "You have already used your bomb.");
        return;
    }

    // Indicate that bomb mode is active for this player
    io.to(currentPlayer.socketId).emit("bomb-mode-active");
    // Temporarily set a flag in the game object for server-side state
    game.bombModeActiveFor = playerNumber;
    console.log(`Player ${playerNumber} in game ${gameId} activated bomb mode.`);
  });

  socket.on("bomb-center-selected", async ({ gameId, x, y, playerNumber }) => {
    const game = games[gameId];
    if (!game) {
        socket.emit("error-message", "Game not found for bomb center.");
        return;
    }

    const currentPlayer = game.players.find(p => p.socketId === socket.id);
    if (!currentPlayer || currentPlayer.number !== playerNumber || game.gameOver || game.bombModeActiveFor !== playerNumber) {
        socket.emit("error-message", "Invalid bomb center selection.");
        return;
    }

    // Mark bomb as used for this player
    game.bombsUsed[playerNumber] = true;
    game.bombModeActiveFor = null; // Deactivate bomb mode

    const blastRadius = 1; // 3x3 area
    let tilesAffected = [];
    let scoreGained = 0;

    for (let dy = -blastRadius; dy <= blastRadius; dy++) {
        for (let dx = -blastRadius; dx <= blastRadius; dx++) {
            const nx = x + dx;
            const ny = y + dy;

            if (nx >= 0 && nx < game.board[0].length && ny >= 0 && ny < game.board.length) {
                const tile = game.board[ny][nx];
                if (!tile.revealed) {
                    tile.revealed = true;
                    tile.owner = playerNumber;
                    tilesAffected.push({ x: nx, y: ny });

                    if (!tile.isMine) {
                        scoreGained += (1 + tile.adjacentMines);
                    } else {
                        scoreGained -= 1; // Deduct point for revealing a mine with bomb
                    }
                }
            }
        }
    }
    game.scores[playerNumber] += scoreGained;

    game.lastClickedTile[playerNumber] = { x, y }; // Update last clicked for bomb center

    // Switch turn
    game.turn = playerNumber === 1 ? 2 : 1;

    // Check for game over after bomb blast
    let allNonMineTilesRevealed = true;
    for (let row of game.board) {
        for (let t of row) {
            if (!t.isMine && !t.revealed) {
                allNonMineTilesRevealed = false;
                break;
            }
        }
        if (!allNonMineTilesRevealed) break;
    }

    if (allNonMineTilesRevealed) {
        game.gameOver = true;
        const winner = game.scores[1] > game.scores[2] ? 1 : game.scores[2] > game.scores[1] ? 2 : 0;
        io.to(gameId).emit("game-over", { winner, scores: game.scores });

        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            scores: game.scores,
            board: JSON.stringify(game.board),
            lastClickedTile: game.lastClickedTile,
            turn: game.turn,
            gameOver: game.gameOver,
            status: 'completed',
            lastUpdated: Timestamp.now()
        });
        console.log(`Game ${gameId} ended by bomb. Winner: Player ${winner}. Final scores: ${game.scores[1]} | ${game.scores[2]}`);
    } else {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            scores: game.scores,
            board: JSON.stringify(game.board),
            lastClickedTile: game.lastClickedTile,
            turn: game.turn,
            gameOver: game.gameOver,
            bombsUsed: game.bombsUsed, // Save bomb usage
            status: 'active',
            lastUpdated: Timestamp.now()
        });
    }

    // Emit updated board to all players and observers
    io.to(gameId).emit("board-update", {
      gameId: game.gameId,
      board: JSON.stringify(game.board),
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
    });
    console.log(`Player ${playerNumber} used bomb in game ${gameId} at ${x},${y}. Affected tiles: ${tilesAffected.length}`);
  });


  socket.on("cancel-bomb", ({ gameId, playerNumber }) => {
    const game = games[gameId];
    if (game && game.bombModeActiveFor === playerNumber) {
        game.bombModeActiveFor = null; // Deactivate bomb mode
        io.to(socket.id).emit("bomb-mode-inactive");
        console.log(`Player ${playerNumber} in game ${gameId} canceled bomb mode.`);
    }
  });


  socket.on("restart-game", async ({ gameId }) => {
    const game = games[gameId];
    if (!game) {
        socket.emit("error-message", "Game not found for restart.");
        return;
    }

    // Ensure game is over before restarting
    if (!game.gameOver) {
        socket.emit("error-message", "Game must be over to restart.");
        return;
    }

    const boardSize = 15;
    const numMines = 30;
    const newBoard = generateBoard(boardSize, numMines);

    game.board = newBoard;
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;
    game.lastClickedTile = { 1: null, 2: null };
    game.observers = []; // Clear observers on restart, they need to rejoin

    // Update Firestore
    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId: game.gameId, // Ensure gameId is present for new set
            board: JSON.stringify(game.board),
            player1_userId: game.players[0].userId,
            player1_name: game.players[0].name,
            player2_userId: game.players[1].userId,
            player2_name: game.players[1].name,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            status: 'active', // Reset status to active
            lastUpdated: Timestamp.now(),
            playerIds: [game.players[0].userId, game.players[1].userId]
        });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error);
        socket.emit("error-message", "Failed to restart game due to a server error.");
        return;
    }

    // Emit game-restarted to all players and observers in the game room
    io.to(gameId).emit("game-restarted", {
        gameId: game.gameId,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
    });
  });

  socket.on("request-unfinished-games", async () => {
    const userId = socket.request.session?.passport?.user?.id;
    if (!userId) {
        console.warn("Attempted to request unfinished games without userId.");
        socket.emit("receive-unfinished-games", []);
        return;
    }
    console.log(`User ${userId} requested unfinished games.`);
    try {
        const unfinishedGamesSnapshot = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['waiting_for_resume', 'active'])
            .where('playerIds', 'array-contains', userId)
            .orderBy('lastUpdated', 'desc')
            .get();

        const gamesToSend = [];
        unfinishedGamesSnapshot.forEach(doc => {
            const gameData = doc.data();
            if (gameData.player1_userId && gameData.player2_userId) {
                const opponentId = gameData.player1_userId === userId ? gameData.player2_userId : gameData.player1_userId;
                const opponentName = gameData.player1_userId === userId ? gameData.player2_name : gameData.player1_name;
                const myPlayerNumber = gameData.player1_userId === userId ? 1 : 2;

                gamesToSend.push({
                    gameId: gameData.gameId,
                    board: JSON.stringify(gameData.board), // Include board for resumption
                    scores: gameData.scores || { 1: 0, 2: 0 },
                    bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
                    turn: gameData.turn,
                    gameOver: gameData.gameOver,
                    opponentName: opponentName,
                    myPlayerNumber: myPlayerNumber,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toISOString() : null,
                    status: gameData.status
                });
            }
        });
        console.log(`Found ${gamesToSend.length} unfinished games for user ${userId}.`);
        socket.emit("receive-unfinished-games", gamesToSend);
    } catch (error) {
        console.error("Error fetching unfinished games:", error);
        socket.emit("error-message", "Failed to load unfinished games.");
    }
});


  // NEW: Request for observable games to display in the lobby
  socket.on("request-observable-games", async () => {
      const userId = socket.request.session?.passport?.user?.id;
      if (!userId) {
          console.warn("Attempted to request observable games without userId.");
          socket.emit("receive-observable-games", []); // Send empty list if not authenticated
          return;
      }

      console.log(`User ${userId} requested observable games.`);
      try {
          // Find active or resumable games that are NOT over and have at least one player
          const observableGamesSnapshot = await db.collection(GAMES_COLLECTION_PATH)
              .where('status', 'in', ['active', 'waiting_for_resume'])
              .where('gameOver', '==', false)
              .orderBy('lastUpdated', 'desc')
              .get();

          const gamesToSend = [];
          observableGamesSnapshot.forEach(doc => {
              const gameData = doc.data();
              // Ensure the game has at least one player to be observable
              // And ensure the current user is NOT a player in this game
              if ((gameData.player1_userId || gameData.player2_userId) && !gameData.playerIds.includes(userId)) {
                   gamesToSend.push({
                      gameId: gameData.gameId,
                      player1_name: gameData.player1_name,
                      player2_name: gameData.player2_name,
                      scores: gameData.scores || { 1: 0, 2: 0 },
                      lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toISOString() : null,
                  });
              }
          });
          console.log(`Found ${gamesToSend.length} observable games for user ${userId}.`);
          socket.emit("receive-observable-games", gamesToSend);
      } catch (error) {
          console.error("Error fetching observable games:", error);
          socket.emit("error-message", "Failed to load observable games.");
      }
  });

  // NEW: Handle joining a game as an observer
  socket.on("join-observer-game", async ({ gameId }) => {
      const userId = socket.request.session?.passport?.user?.id;
      const name = socket.request.session?.passport?.user?.name;

      if (!userId || !name) {
          socket.emit("error-message", "Authentication required to observe a game.");
          return;
      }

      let game = games[gameId];
      if (!game) {
          // Try to load from Firestore if not in memory
          try {
              const doc = await db.collection(GAMES_COLLECTION_PATH).doc(gameId).get();
              if (doc.exists) {
                  const gameData = doc.data();
                  if (gameData.status === 'active' || gameData.status === 'waiting_for_resume') {
                      // Reconstruct game object for in-memory access
                      game = {
                          gameId: gameData.gameId,
                          board: JSON.parse(gameData.board),
                          scores: gameData.scores || { 1: 0, 2: 0 },
                          bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
                          turn: gameData.turn,
                          gameOver: gameData.gameOver,
                          lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null },
                          players: [], // Will populate based on in-memory players or from gameData
                          observers: [] // Initialize for loaded game
                      };
                      // Add to in-memory games list
                      games[gameId] = game;

                      // Populate players list for the in-memory game object
                      const player1Data = players.find(p => p.userId === gameData.player1_userId);
                      const player2Data = players.find(p => p.userId === gameData.player2_userId);
                      if (player1Data) game.players.push({ ...player1Data, number: 1, socketId: userSocketMap[player1Data.userId] || null });
                      if (player2Data) game.players.push({ ...player2Data, number: 2, socketId: userSocketMap[player2Data.userId] || null });

                  } else {
                      socket.emit("error-message", "Game not available for observation.");
                      return;
                  }
              } else {
                  socket.emit("error-message", "Game not found.");
                  return;
              }
          } catch (error) {
              console.error("Error loading game for observation:", error);
              socket.emit("error-message", "Failed to load game for observation.");
              return;
          }
      }

      // Prevent observing if already a player in this game
      if (game.players.some(p => p.userId === userId)) {
          socket.emit("error-message", "You are a player in this game. Use 'Resume' instead of 'Observe'.");
          return;
      }

      // Add observer to the game's observer list
      const existingObserver = game.observers.find(o => o.userId === userId);
      if (!existingObserver) {
          game.observers.push({ userId, name, socketId: socket.id });
          console.log(`Observer ${name} (${userId}) joined game ${gameId}.`);
      } else {
          // Update socketId if observer reconnected
          existingObserver.socketId = socket.id;
          console.log(`Observer ${name} (${userId}) reconnected to game ${gameId}.`);
      }

      // Join the socket room for this game
      socket.join(gameId);
      userGameMap[userId] = gameId; // Map observer to the game they are observing

      // Send current game state to the observer
      socket.emit("game-start", { // Re-using game-start event for initial observer view
          gameId: game.gameId,
          playerNumber: null, // Observers don't have a player number
          board: JSON.stringify(game.board),
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          lastClickedTile: game.lastClickedTile,
          opponentName: game.players[0] && game.players[1] ? `${game.players[0].name} vs ${game.players[1].name}` : "Players", // Display both player names
          isObserver: true // Important flag for frontend
      });
      io.to(gameId).emit("observer-joined", { name: name }); // Notify players/other observers in the game room
  });

  // NEW: Handle leaving a game as an observer
  socket.on("leave-observer-game", ({ gameId }) => {
      const userId = socket.request.session?.passport?.user?.id;
      const name = socket.request.session?.passport?.user?.name;

      if (!userId || !gameId || !games[gameId]) {
          console.warn(`Attempted to leave non-existent observer game or without user/gameId: ${gameId}`);
          return;
      }

      const game = games[gameId];
      game.observers = game.observers.filter(o => o.userId !== userId);
      socket.leave(gameId); // Leave the socket room
      delete userGameMap[userId]; // Remove mapping

      // Notify players/other observers in the game room that an observer left
      io.to(gameId).emit("observer-left", { name: name });
      console.log(`Observer ${name} (${userId}) left game ${gameId}.`);
  });


  socket.on("leave-game", async ({ gameId }) => {
    const userId = socket.request.session?.passport?.user?.id;
    if (!userId || !gameId) return;

    const game = games[gameId];
    if (game) {
        // Mark game as waiting for resume in Firestore
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'waiting_for_resume', // Set game status to waiting_for_resume
                lastUpdated: Timestamp.now(),
                // Save current state of game when player leaves
                board: JSON.stringify(game.board),
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                turn: game.turn,
                gameOver: game.gameOver,
                lastClickedTile: game.lastClickedTile,
                // Ensure player info for re-joining is accurate
                player1_userId: game.players[0]?.userId,
                player1_name: game.players[0]?.name,
                player2_userId: game.players[1]?.userId,
                player2_name: game.players[1]?.name,
                playerIds: game.players.map(p => p.userId)
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
        } catch (error) {
            console.error("[Leave Game] Error updating game status to 'waiting_for_resume' in Firestore:", error);
        }

        // Notify the opponent if one exists and is still connected
        const opponentPlayer = game.players.find(p => p.userId !== userId);
        if (opponentPlayer && opponentPlayer.socketId && io.sockets.sockets.has(opponentPlayer.socketId)) {
            io.to(opponentPlayer.socketId).emit("opponent-left");
        }
        
        // Remove current player from game.players in memory
        game.players = game.players.filter(p => p.userId !== userId);
        if (game.players.length === 0 && game.observers.length === 0) {
            // If no players or observers left, remove game from memory
            delete games[gameId];
            console.log(`Game ${gameId} removed from memory as no players or observers remain.`);
        }

        socket.leave(gameId); // Leave the socket room
        delete userGameMap[userId]; // Remove user's game mapping
        console.log(`Player ${userName} (${userId}) left game ${gameId}.`);
    }
  });


  socket.on("disconnect", async () => {
    console.log(`User disconnected: ${socket.id}`);
    const disconnectedUserId = Object.keys(userSocketMap).find(key => userSocketMap[key] === socket.id);

    if (disconnectedUserId) {
      delete userSocketMap[disconnectedUserId]; // Remove from active socket map

      const gameId = userGameMap[disconnectedUserId];
      const game = games[gameId];

      if (game) {
        // Check if the disconnected user was a player
        const wasPlayer = game.players.some(p => p.userId === disconnectedUserId);
        // Check if the disconnected user was an observer
        const wasObserver = game.observers.some(o => o.userId === disconnectedUserId);

        if (wasPlayer) {
            game.players = game.players.filter(p => p.userId !== disconnectedUserId);
            console.log(`Player ${disconnectedUserId} disconnected from game ${gameId}. Remaining players: ${game.players.length}`);

            // Update Firestore status to waiting_for_resume only if game not over and still has players or observers
            if (!game.gameOver) {
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                        status: 'waiting_for_resume', // Set game status to waiting_for_resume
                        lastUpdated: Timestamp.now(),
                        // Save current state of game when player leaves
                        board: JSON.stringify(game.board),
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        turn: game.turn,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        // Ensure player info for re-joining is accurate
                        player1_userId: game.players[0]?.userId, // Might be null if only 1 player disconnects
                        player1_name: game.players[0]?.name,
                        player2_userId: game.players[1]?.userId,
                        player2_name: game.players[1]?.name,
                        playerIds: game.players.map(p => p.userId) // Ensure playerIds reflect remaining players
                    }, { merge: true });
                    console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
                } catch (error) {
                    console.error("[Disconnect] Error updating game status to 'waiting_for_resume' on disconnect:", error);
                }
            }

            // Notify the opponent if one exists and is still connected
            const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
            if (remainingPlayer && remainingPlayer.socketId && io.sockets.sockets.has(remainingPlayer.socketId)) {
                io.to(remainingPlayer.socketId).emit("opponent-left"); // Inform the opponent
                console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
            } else if (game.players.length === 0 && game.observers.length > 0) {
                 // If no players but observers, notify observers
                 io.to(gameId).emit("player-disconnected", { name: userName }); // Notify observers in the room
            }
            
        } else if (wasObserver) {
            game.observers = game.observers.filter(o => o.userId !== disconnectedUserId);
            console.log(`Observer ${disconnectedUserId} disconnected from game ${gameId}.`);
            io.to(gameId).emit("observer-left", { name: userName }); // Notify players/other observers
        }

        // Clean up game from memory if no players and no observers left, and game is not 'waiting_for_resume'
        // Or if the game is over and no one is left
        if (game.players.length === 0 && game.observers.length === 0) {
            if (game.gameOver || game.status !== 'waiting_for_resume') { // if it's not active/resumable and empty
                delete games[gameId];
                console.log(`Game ${gameId} removed from memory as no players or observers remain.`);
            }
        }
      }

      delete userGameMap[disconnectedUserId]; // Always remove from userGameMap on disconnect
    }

    // Clean up lobby players
    players = players.filter(p => p.id !== socket.id);
    io.emit("update-player-list", players.filter(p => p.id !== socket.id));
  });

});

// --- Server Startup ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
