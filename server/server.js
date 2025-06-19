// server.js

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const passport = require("passport");
const session = require("express-session");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy; // Import Facebook Strategy
const { v4: uuidv4 } = require("uuid"); // For generating unique game IDs

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { Firestore } = require('@google-cloud/firestore'); // Required by @google-cloud/connect-firestore

// --- NEW: Corrected Firestore Session Store Imports ---
// The @google-cloud/connect-firestore module exports FirestoreStore as a named export.
// It is then instantiated with 'new', and does NOT take 'session' directly in the require call.
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
// IMPORTANT: Add this line to trust proxy headers when deployed to Render
app.set('trust proxy', 1); 
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID)
const userGameMap = {};   // Maps userId to the gameId they are currently in

// Configure CORS for Express
// MUST match your frontend Render URL exactly
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true, // Allow cookies to be sent cross-origin
  })
);

// === Environment Variables for OAuth (DO NOT HARDCODE IN PRODUCTION) ===
// These should be set on Render as environment variables.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Declare `db`, `sessionMiddleware`, and `io` variables here ===
let db;
let sessionMiddleware;
let io; // Declare io here so it's accessible globally

// --- Game Constants (Moved to a more global scope) ---
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;
const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app";
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;

// Determine cookie domain dynamically for production vs local development
const NODE_ENV = process.env.NODE_ENV || 'development';


try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  // Add detailed logging for service account parsing
  console.log(`[Firebase Init] Service Account Project ID: ${serviceAccount.project_id}`);
  const privateKeyCleaned = serviceAccount.private_key.replace(/\\n/g, '\n');
  console.log(`[Firebase Init] Private Key (first 20 chars): ${privateKeyCleaned.substring(0, 20)}...`);
  console.log(`[Firebase Init] Private Key Length: ${privateKeyCleaned.length}`);


  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore(); // Initialize db for Admin SDK operations

  // Create a separate Firestore client instance for the session store.
  // This is how @google-cloud/connect-firestore expects it.
  const firestoreClient = new Firestore({
    projectId: serviceAccount.project_id, // Use project_id from service account
    credentials: {
      client_email: serviceAccount.client_email,
      // Ensure private_key handles actual newlines, as required by @google-cloud/firestore client
      private_key: privateKeyCleaned, // Use the cleaned private key
    },
    // Explicitly target the default database to avoid potential issues
    databaseId: '(default)',
  });

  // === Define the session middleware instance with FirestoreStore ===
  sessionMiddleware = session({ // Assign to the already declared variable
    secret: process.env.SESSION_SECRET || "super-secret-fallback-key-for-dev", // Use env var, fallback for local dev
    resave: false, // Changed to false: generally recommended to only resave modified sessions
    saveUninitialized: false, // Prevents storing empty sessions in Firestore
    store: new FirestoreStore({ // Instantiate FirestoreStore with 'new'
      dataset: firestoreClient, // Pass the Firestore client instance
      kind: 'express-sessions', // Optional: collection name for sessions, defaults to 'express-sessions'
    }),
    cookie: {
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24, // 24 hours (example)
      proxy: true, // IMPORTANT: Inform express-session that it's behind a proxy
    },
  });

  // === Apply session middleware to Express ===
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  console.log("Firebase Admin SDK and FirestoreStore initialized.");


  // Configure Socket.IO with CORS
  io = new Server(server, { // Assign to the already declared 'io' variable
    cors: {
      origin: "https://minesweeper-flags-frontend.onrender.com",
      methods: ["GET", "POST"],
      credentials: true, // Allow cookies for Socket.IO handshake
    },
  });

  // === IMPORTANT: Integrate session and passport middleware with Socket.IO ===
  // Moved inside try block to ensure sessionMiddleware is defined
  io.use((socket, next) => {
      // Mock a 'res' object for session and passport middleware compatibility
      const dummyRes = {
          writeHead: () => {}, // Add no-op writeHead
          end: () => {} // Add no-op end
      };
      socket.request.res = dummyRes;

      // Apply session middleware
      sessionMiddleware(socket.request, socket.request.res, () => {
          // Apply passport.initialize
          passport.initialize()(socket.request, socket.request.res, () => {
              // Apply passport.session
              passport.session()(socket.request, socket.request.res, () => {
                  next();
              });
          });
      });
  });
  // === END Socket.IO Session Integration ===


} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK or FirestoreStore.", error);
  process.exit(1); // Exit process if initialization fails
}


// === Passport config ===
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, displayName: profile.displayName }); // Store object with ID and displayName
}));

passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID, // Correctly using the declared variable
  clientSecret: FACEBOOK_CLIENT_SECRET, // Correctly using the declared variable
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  cb(null, { id: profile.id, displayName: profile.displayName }); // Store object with ID and displayName
}));


// Passport Serialization/Deserialization
passport.serializeUser((user, done) => {
  done(null, user); // Store the entire user object in the session
});

passport.deserializeUser((user, done) => {
  done(null, user); // Pass the user object back to req.user
});


// === Authentication Routes ===

// Google Auth Initiate
app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

// Google Auth Callback
app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => { // Add a callback to manually save session
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Google auth:", err);
      } else {
        console.log(`[Session Save] Session successfully saved after Google auth.`);
      }
      res.redirect("https://minesweeper-flags-frontend.onrender.com");
    });
  }
);

// Facebook Auth Initiate
app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

// Facebook Auth Callback
app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => { // Add a callback to manually save session
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Facebook auth:", err);
      } else {
        console.log(`[Session Save] Session successfully saved after Facebook auth.`);
      }
      res.redirect("https://minesweeper-flags-frontend.onrender.com");
    });
  }
);


// Logout Route
app.get("/logout", (req, res, next) => {
  req.logout((err) => { // Passport's logout method
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => { // Destroy the session on the server
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          secure: true,
          sameSite: 'none',
          proxy: true, // Clear cookie with proxy setting
      }); // Clear the session cookie from the client
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

// Login Check Route
app.get("/me", (req, res) => {
  if (req.isAuthenticated() && req.user) {
    res.json({ user: req.user }); // req.user now contains id and displayName
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});


// Global Game Data Structures
let players = []; // Lobby players: [{ id: socket.id, userId, name }]
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], board, scores, bombsUsed, turn, gameOver }

// Helper to generate a new Minesweeper board
const generateBoard = () => {
  const board = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null, // Player number who claimed the mine
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
  // Check bounds and if already revealed
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || board[y][x].revealed) {
    return;
  }

  const tile = board[y][x];
  tile.revealed = true; // Mark as revealed

  // If it's a blank tile (0 adjacent mines) and not a mine, propagate reveal
  if (tile.adjacentMines === 0 && !tile.isMine) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) { // Exclude the center tile itself
          revealRecursive(board, x + dx, y + dy);
        }
      }
    }
  }
};

// Helper for bomb ability 5x5 reveal
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
            tile.owner = playerNumber; // Assign bomb owner
            scores[playerNumber]++; // Increment score for captured mine
          } else {
            revealRecursive(board, x, y); // Recursively reveal non-mine tiles
          }
        }
      }
    }
  }
};

// Helper to check for game over condition
const checkGameOver = (scores) => {
  // Game over if either player reaches 26 flags (mines)
  return scores[1] >= 26 || scores[2] >= 26;
};


// === Socket.IO Connection and Game Events ===
io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Passport.js attaches session to socket.request
  const user = socket.request.session?.passport?.user || null;
  const userId = user ? user.id : null;
  const userName = user ? user.displayName : null;

  if (userId) {
    console.log(`User ${userName} (${userId}) (re)connected. Socket ID: ${socket.id}`);

    // Always update user-to-socket mapping with the latest socket ID
    userSocketMap[userId] = socket.id;

    // Handle rejoining an existing game if user was previously in one or if it's stored in Firestore
    if (userGameMap[userId]) {
        const gameId = userGameMap[userId];
        let game = games[gameId]; // Try to get from in-memory first

        if (!game) { // If not in memory, try to load from Firestore
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                    const gameData = doc.data();
                    const deserializedBoard = JSON.parse(gameData.board);

                    // Reconstruct in-memory game object
                    game = {
                        gameId: gameData.gameId,
                        board: deserializedBoard,
                        scores: gameData.scores,
                        bombsUsed: gameData.bombsUsed,
                        turn: gameData.turn,
                        gameOver: gameData.gameOver,
                        players: [] // Will be populated with proper player objects
                    };

                    // Find or create player objects for the in-memory game structure
                    let player1 = players.find(p => p.userId === gameData.player1_userId);
                    if (!player1) {
                        player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 };
                        players.push(player1); // Add to global players list
                    }
                    player1.socketId = userSocketMap[player1.userId] || null; // Update socketId from userSocketMap

                    let player2 = players.find(p => p.userId === gameData.player2_userId);
                    if (!player2) {
                        player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 };
                        players.push(player2); // Add to global players list
                    }
                    player2.socketId = userSocketMap[player2.userId] || null; // Update socketId from userSocketMap

                    game.players = [player1, player2];
                    games[gameId] = game; // Add game to in-memory active games

                    // Set game status to active if it was waiting for resume
                    if (gameData.status === 'waiting_for_resume') {
                        doc.ref.update({ status: 'active', lastUpdated: Timestamp.now() }).then(() => {
                            console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);
                        }).catch(e => console.error("Error updating game status on resume:", e));
                    }

                    const playerInGame = game.players.find(p => p.userId === userId);
                    const opponentPlayer = game.players.find(op => op.userId !== userId);

                    // Send game state to reconnected player
                    if (playerInGame && playerInGame.socketId) {
                        io.to(playerInGame.socketId).emit("game-start", {
                            gameId: game.gameId,
                            playerNumber: playerInGame.number,
                            board: JSON.stringify(game.board),
                            turn: game.turn,
                            scores: game.scores,
                            bombsUsed: game.bombsUsed,
                            gameOver: game.gameOver,
                            opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                        });
                        console.log(`Emitted game-start to reconnected user ${playerInGame.name} for game ${gameId}.`);
                    }

                    // Notify opponent if they are also online
                    if (opponentPlayer && opponentPlayer.socketId) {
                        io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                        console.log(`Notified opponent ${opponentPlayer.name} of ${playerInGame.name} re-connection in game ${gameId}.`);
                    }
                    // Update lobby list as this game might become active
                    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));
                } else {
                    delete userGameMap[userId]; // Game not found or invalid status, clear map
                    console.log(`Game ${gameId} for user ${userId} not found or invalid status in Firestore, clearing map.`);
                }
            }).catch(e => console.error("Error fetching game from Firestore on reconnect:", e));
        } else { // Game found in memory
            const playerInGame = game.players.find(p => p.userId === userId);
            if (playerInGame) {
                playerInGame.socketId = socket.id; // Ensure current socketId is used in game object
                const opponentPlayer = game.players.find(op => op.userId !== userId);

                // Re-send game state to ensure client is up-to-date
                io.to(playerInGame.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: playerInGame.number,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`Re-sent active game state for game ${gameId} to ${playerInGame.name}.`);

                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                    console.log(`Notified opponent ${opponentPlayer.name} of ${playerInGame.name} re-connection in game ${gameId}.`);
                }
            }
        }
    }
  } else {
      console.log(`Unauthenticated socket ${socket.id} connected.`);
  }

  // Lobby Join Event
  socket.on("join-lobby", (name) => {
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : name; // Use displayName from Passport if available, else provided name

    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby.");
        console.warn(`Unauthenticated socket ${socket.id} tried to join lobby.`);
        return;
    }

    // Ensure userSocketMap is updated
    userSocketMap[userId] = socket.id;

    // Ensure only one entry per userId in the players list, update socket.id if rejoining
    players = players.filter(p => p.userId !== userId);
    players.push({ id: socket.id, userId: userId, name: userName }); // Store userId and current socket.id

    console.log(`Player ${userName} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined", userName); // Send back the name used
    // Emit updated player list to all connected clients in the lobby (all players now)
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));
  });

  socket.on("request-unfinished-games", async () => {
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume']) // Fetch active or waiting games
            .get();

        let unfinishedGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            // Check if the current user is part of this game
            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;

            if (isPlayer1 || isPlayer2) {
                // Determine opponent's name
                const opponentName = isPlayer1 ? gameData.player2_name : gameData.player1_name;
                const myPlayerNumber = isPlayer1 ? 1 : 2;

                // Ensure the game is NOT already active in the current server's in-memory `games` object
                // AND the user's current socket is NOT already playing it.
                const isCurrentlyActiveInMemoryForThisSocket = games[gameData.gameId] && 
                                                               games[gameData.gameId].players.some(p => p.userId === userId && p.socketId === socket.id);

                if (!isCurrentlyActiveInMemoryForThisSocket) {
                    unfinishedGames.push({
                        gameId: gameData.gameId,
                        board: gameData.board, // Send serialized board for potential client-side preview
                        opponentName: opponentName,
                        myPlayerNumber: myPlayerNumber,
                        status: gameData.status,
                        lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                    });
                }
            }
        });

        socket.emit("receive-unfinished-games", unfinishedGames);
        console.log(`Sent ${unfinishedGames.length} unfinished games to user ${userName}.`);

    } catch (error) {
        console.error("Error fetching unfinished games for user:", userId, error);
        socket.emit("join-error", "Failed to load your unfinished games.");
    }
  });

  socket.on("resume-game", async ({ gameId }) => {
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to resume game.");
        return;
    }

    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        const gameDoc = await gameDocRef.get();

        if (!gameDoc.exists) {
            socket.emit("join-error", "Game not found or already ended.");
            return;
        }

        const gameData = gameDoc.data();

        // Verify that the resuming user is one of the players in this game
        if (gameData.player1_userId !== userId && gameData.player2_userId !== userId) {
            socket.emit("join-error", "You are not a participant in this game.");
            return;
        }

        // Check if the game is already active in memory for *any* player
        if (games[gameId]) {
            const existingGame = games[gameId];
            const playerInExistingGame = existingGame.players.find(p => p.userId === userId);

            if (playerInExistingGame && playerInExistingGame.socketId === socket.id) {
                // Player is trying to resume a game they are already actively connected to with this socket.
                // Just re-send the current state.
                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: JSON.stringify(existingGame.board),
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`User ${userName} re-sent active game state for game ${gameId}.`);
                return;
            } else if (playerInExistingGame && playerInExistingGame.socketId !== socket.id) {
                // User is in the game in memory but with an old socket ID, update it
                playerInExistingGame.socketId = socket.id;
                userSocketMap[userId] = socket.id; // Update global userSocketMap

                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: JSON.stringify(existingGame.board),
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`User ${userName} re-associated socket ID for active game ${gameId}.`);
                // Notify opponent that their partner reconnected
                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: userName });
                }
                return;
            }
            // If the game exists in memory but this user isn't part of it, or the game is full/has an active player who is not this user.
            // This scenario implies a conflict (e.g., player trying to join a game already resumed by another account or another instance).
            socket.emit("join-error", "Game is currently active with another player or your other session.");
            console.warn(`User ${userName} tried to resume game ${gameId} but it's already active or user is in another game.`);
            return;
        }

        // If game not in memory, load from Firestore
        const deserializedBoard = JSON.parse(gameData.board); // Deserialize board from Firestore string

        const game = {
            gameId: gameData.gameId,
            board: deserializedBoard, // Use the deserialized board
            scores: gameData.scores,
            bombsUsed: gameData.bombsUsed,
            turn: gameData.turn,
            gameOver: gameData.gameOver,
            players: [] // Will populate based on who is resuming
        };

        // Populate players array for the in-memory game object
        const p1UserId = gameData.player1_userId;
        const p2UserId = gameData.player2_userId;

        // Ensure players exist in the global 'players' list or add them temporarily
        let player1 = players.find(p => p.userId === p1UserId);
        if (!player1) {
            player1 = { userId: p1UserId, name: gameData.player1_name, number: 1 };
            players.push(player1);
        }
        player1.socketId = userSocketMap[p1UserId] || null; // Get current socket ID from map
        player1.inGame = true; // Mark as in game

        let player2 = players.find(p => p.userId === p2UserId);
        if (!player2) {
            player2 = { userId: p2UserId, name: gameData.player2_name, number: 2 };
            players.push(player2);
        }
        player2.socketId = userSocketMap[p2UserId] || null; // Get current socket ID from map
        player2.inGame = true; // Mark as in game

        game.players = [player1, player2];
        games[gameId] = game; // Add game to in-memory active games
        userGameMap[p1UserId] = gameId; // Map both players to this game
        userGameMap[p2UserId] = gameId;

        // Update Firestore status if it was waiting for resume
        if (gameData.status === 'waiting_for_resume') {
            await gameDocRef.update({ status: 'active', lastUpdated: Timestamp.now() });
            console.log(`Game ${gameId} status updated to 'active' in Firestore.`);
        }

        // Emit game-start to the player who resumed
        const currentPlayerInGame = game.players.find(p => p.userId === userId);
        const opponentPlayerInGame = game.players.find(op => op.userId !== userId);

        if (currentPlayerInGame && currentPlayerInGame.socketId) {
            io.to(currentPlayerInGame.socketId).emit("game-start", {
                gameId: game.gameId,
                playerNumber: currentPlayerInGame.number,
                board: JSON.stringify(game.board), // Send serialized board
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                opponentName: opponentPlayerInGame ? opponentPlayerInGame.name : "Opponent"
            });
            console.log(`User ${userName} successfully resumed game ${gameId}.`);
        }

        // If opponent is also connected, notify them that game is active again
        if (opponentPlayerInGame && opponentPlayerInGame.socketId) {
            io.to(opponentPlayerInGame.socketId).emit("opponent-reconnected", { name: userName });
            console.log(`Notified opponent ${opponentPlayerInGame.name} that ${userName} reconnected to game ${gameId}.`);
        }

        // Update lobby player list (all players now)
        io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));

    } catch (error) {
        console.error("Error resuming game:", error);
        socket.emit("join-error", "Failed to resume game. " + error.message);
    }
  });


  // Invite Player Event
  socket.on("invite-player", (targetSocketId) => {
    const inviterUser = socket.request.session?.passport?.user || null;
    const inviterUserId = inviterUser ? inviterUser.id : null;
    
    const inviterPlayer = players.find((p) => p.userId === inviterUserId);
    const invitedPlayer = players.find((p) => p.id === targetSocketId); // targetSocketId is the socket.id from playersList on client

    if (!inviterPlayer || !invitedPlayer) {
      console.warn(`Invite failed: Inviter or invitee not found. Inviter: ${inviterPlayer?.name}, Invitee: ${invitedPlayer?.name}`);
      return;
    }
    // Check if either player is already associated with a game
    if (userGameMap[inviterPlayer.userId] || userGameMap[invitedPlayer.userId]) {
        console.warn(`Invite failed: Inviter (${inviterPlayer.name}) or invitee (${invitedPlayer.name}) already in game.`);
        // Optionally, send a message back to the inviter
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: invitedPlayer.name, reason: "Player is already in a game." });
        return;
    }


    io.to(invitedPlayer.id).emit("game-invite", {
      fromId: inviterPlayer.id, // This is the inviter's current socket.id
      fromName: inviterPlayer.name,
    });
    console.log(`Invite sent from ${inviterPlayer.name} to ${invitedPlayer.name}`);
  });

  // Respond to Invite Event
  socket.on("respond-invite", async ({ fromId, accept }) => {
    const respondingUser = socket.request.session?.passport?.user || null;
    const respondingUserId = respondingUser ? respondingUser.id : null;

    const respondingPlayer = players.find((p) => p.userId === respondingUserId);
    const inviterPlayer = players.find((p) => p.id === fromId); // fromId is inviter's socket.id

    if (!respondingPlayer || !inviterPlayer) {
        console.warn("Respond invite failed: Players not found.");
        return;
    }

    // Double check if either player is already in a game
    if (userGameMap[respondingPlayer.userId] || userGameMap[inviterPlayer.userId]) {
        console.warn("Respond invite failed: One or both players already in a game.");
        io.to(respondingPlayer.id).emit("invite-rejected", { fromName: inviterPlayer.name, reason: "Already in another game" });
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: respondingPlayer.name, reason: "Already in another game" });
        return;
    }

    if (accept) {
      const gameId = uuidv4(); // Generate a unique game ID
      const newBoard = generateBoard();
      const scores = { 1: 0, 2: 0 };
      const bombsUsed = { 1: false, 2: false };
      const turn = 1;
      const gameOver = false;

      const game = {
        gameId,
        board: newBoard,
        players: [
          // Store userId and current socketId for players in the game object
          { userId: inviterPlayer.userId, name: inviterPlayer.name, number: 1, socketId: inviterPlayer.id },
          { userId: respondingPlayer.userId, name: respondingPlayer.name, number: 2, socketId: respondingPlayer.id },
        ],
        turn,
        scores,
        bombsUsed,
        gameOver,
      };
      games[gameId] = game;

      // Update userGameMap for both players
      userGameMap[inviterPlayer.userId] = gameId;
      userGameMap[respondingPlayer.userId] = gameId;
      console.log(`Game ${gameId} started between ${inviterPlayer.name} (${inviterPlayer.userId}) and ${respondingPlayer.name} (${respondingPlayer.userId}).`);

      // Remove players from the general lobby list as they are now in a game
      io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));

      // Emit game-start to both players with their specific player number and opponent name
      io.to(inviterPlayer.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 1,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        opponentName: respondingPlayer.name,
      });
      io.to(respondingPlayer.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 2,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        opponentName: inviterPlayer.name,
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: respondingPlayer.name });
      console.log(`Invite from ${inviterPlayer.name} rejected by ${respondingPlayer.name}.`);
    }
  });


  // Tile Click Event (main game action)
  socket.on("tile-click", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) {
        console.warn(`Tile click: Game ${gameId} not found or game over.`);
        return;
    }

    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    if (!userId) {
        console.warn(`Tile click: Unauthenticated user ${socket.id}.`);
        return;
    }

    // Find the player within the game object using their userId (more reliable for turn check)
    const player = game.players.find((p) => p.userId === userId);
    if (!player || player.number !== game.turn) {
        console.warn(`Tile click: Not player's turn or player not found in game. Player: ${player?.name}, Turn: ${game?.turn}`);
        return;
    }

    // IMPORTANT: Update player's socketId in the game object with current socket.id
    // This ensures subsequent emits (like board-update, game-restarted) go to the correct, potentially new, socket.id
    player.socketId = socket.id;

    const tile = game.board[y][x];
    if (tile.revealed) {
        console.warn(`Tile click: Tile ${x},${y} already revealed.`);
        return;
    }

    // --- Start of Re-ordered and Corrected Logic ---
    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number; // Assign owner to the mine
      game.scores[player.number]++; // Increment score for capturing a mine

      console.log(`[Tile Click] Player ${player.name} revealed a mine at (${x},${y}). New score: ${game.scores[player.number]}`);

      if (checkGameOver(game.scores)) {
          game.gameOver = true;
          console.log(`[Game Over] Game ${gameId} ended. Final Scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);
      }
      // Turn does NOT switch if a mine is revealed.
      // The turn will only switch after a non-mine tile is revealed.

    } else { // This block handles non-mine tiles
      const isBlankTile = tile.adjacentMines === 0;
      const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0;

      // Debug logs removed as requested in previous turn after confirmation
      // console.log(`[Tile Click Debug] Tile at (${x},${y}).`);
      // console.log(`[Tile Click Debug] tile.isMine: ${tile.isMine}, tile.adjacentMines: ${tile.adjacentMines}, tile.revealed: ${tile.revealed}`);
      // console.log(`[Tile Click Debug] Current scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);
      // console.log(`[Tile Click Debug] isBlankTile (calculated from adjacentMines): ${isBlankTile}`);
      // console.log(`[Tile Click Debug] noFlagsRevealedYet (calculated from scores): ${noFlagsRevealedYet}`);
      // console.log(`[Tile Click Debug] Combined restart condition (isBlankTile && noFlagsRevealedYet): ${isBlankTile && noFlagsRevealedYet}`);

      if (isBlankTile && noFlagsRevealedYet) {
        console.log(`[GAME RESTART TRIGGERED] Player ${player.name} (${player.userId}) hit a blank tile at ${x},${y} before any flags were revealed. Restarting game ${gameId}.`);

        // Reset game state properties within the existing game object
        game.board = generateBoard(); // Generate a brand new board
        game.scores = { 1: 0, 2: 0 }; // Reset scores
        game.bombsUsed = { 1: false, 2: false }; // Reset bomb usage
        game.turn = 1; // Reset turn to player 1
        game.gameOver = false; // Game is no longer over

        try {
          const serializedBoard = JSON.stringify(game.board);
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
              board: serializedBoard,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              turn: game.turn,
              gameOver: game.gameOver,
              status: 'active', // Game is active after restart
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          });
          console.log(`Game ${gameId} restarted and updated in Firestore.`);
        } catch (error) {
            console.error("Error restarting game in Firestore:", error);
        }

        game.players.forEach(p => {
            if (p.socketId) {
                const opponentPlayer = game.players.find(op => op.userId !== p.userId);
                io.to(p.socketId).emit("game-restarted", {
                    gameId: game.gameId,
                    playerNumber: p.number,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
            } else {
                console.warn(`Player ${p.name} in game ${gameId} has no active socket. Cannot send restart event.`);
            }
        });
        console.log(`[GAME RESTARTED] Game ${gameId} state after reset. Players: ${game.players.map(p => p.name).join(', ')}`);
        return; // Important: Exit after restarting
      }

      // If not a mine and not a restart condition on a blank tile, then it's a normal reveal
      revealRecursive(game.board, x, y);
      game.turn = game.turn === 1 ? 2 : 1; // Turn switches only for non-mine reveals
    }
    // --- End of Re-ordered and Corrected Logic ---

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (tile-click).`);
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error);
    }

    // Emit board-update to both players
    game.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit("board-update", {
                gameId: game.gameId,
                playerNumber: p.number,
                board: JSON.stringify(game.board), // Send serialized board to client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
            });
        } else {
             console.warn(`Player ${p.name} in game ${gameId} has no active socket. Cannot send board update.`);
        }
    });
  });

  // Use Bomb Event
  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const player = game.players.find((p) => p.userId === userId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Update socket ID on action

    io.to(player.socketId).emit("wait-bomb-center");
    console.log(`Player ${player.name} is waiting for bomb center selection.`);
  });

  // Bomb Center Selected Event
  socket.on("bomb-center", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const player = game.players.find((p) => p.userId === userId);
    if (!player || game.bombsUsed[player.number]) return;

    player.socketId = socket.id; // Update socket ID on action

    const MIN_COORD = 2;
    const MAX_COORD_X = WIDTH - 3;
    const MAX_COORD_Y = HEIGHT - 3;

    if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
      console.log(`Bomb center (${x},${y}) out of bounds for 5x5 blast.`);
      io.to(player.socketId).emit("bomb-error", "Bomb center must be within the 12x12 area.");
      return;
    }

    let allTilesRevealed = true;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const checkX = x + dx;
        const checkY = y + dy;
        if (checkX >= 0 && checkX < WIDTH && checkY >= 0 && checkY < HEIGHT) {
          if (!game.board[checkY][checkX].revealed) {
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
      console.log(`Bomb area at (${x},${y}) already fully revealed.`);
      io.to(player.socketId).emit("bomb-error", "All tiles in the bomb area are already revealed.");
      return;
    }


    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) game.gameOver = true;
    else game.turn = game.turn === 1 ? 2 : 1;

    console.log(`Player ${player.name} used bomb at ${x},${y}. New scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            board: serializedBoard, // Update with serialized board
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (bomb-center).`);
    } catch (error) {
        console.error("Error updating game in Firestore (bomb-center):", error); // Log the full error object
    }


    game.players.forEach(p => {
        if (p.socketId) {
            io.to(p.socketId).emit("board-update", {
                gameId: game.gameId,
                playerNumber: p.number,
                board: JSON.stringify(game.board), // Send serialized board to client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
            });
        }
    });
  });

  // Restart Game Event (Manual Restart Button)
  socket.on("restart-game", async ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;
    
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const requestingPlayer = game.players.find(p => p.userId === userId);
    if (!requestingPlayer) return;

    console.log(`Manual restart requested by ${requestingPlayer.name} for game ${gameId}.`);

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            board: serializedBoard, // Update with serialized board
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            status: 'active', // Game is active after restart
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null
        });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error); // Log the full error object
    }

    game.players.forEach(p => {
        if (p.socketId) {
            const opponentPlayer = game.players.find(op => op.userId !== p.userId);
            io.to(p.socketId).emit("game-restarted", { // Use game-restarted event
                gameId: game.gameId,
                playerNumber: p.number,
                board: JSON.stringify(game.board), // Send serialized board to client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
            });
        }
    });
  });

  // Leave Game Event (Player voluntarily leaves)
  socket.on("leave-game", async ({ gameId }) => {
    const game = games[gameId];
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;

    if (game && userId) {
      const playerIndex = game.players.findIndex(p => p.userId === userId);
      if (playerIndex !== -1) {
        // Remove from userGameMap
        delete userGameMap[userId];
        console.log(`User ${userId} (${game.players[playerIndex].name}) left game ${gameId}.`);

        // Remove the player from the game's player list in memory
        game.players.splice(playerIndex, 1);

        if (game.players.length === 0) {
          // If no players left in the game, delete the game from memory and Firestore
          delete games[gameId];
          try {
              await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                  status: 'completed', // Mark as completed if all players left
                  lastUpdated: Timestamp.now()
              });
              console.log(`Game ${gameId} status set to 'completed' in Firestore as all players left.`);
          }
           catch (error) {
              console.error("Error updating game status to 'completed' on leave:", error);
          }
          console.log(`Game ${gameId} deleted from memory.`);
        } else {
          // Notify the remaining player if any (using their current socketId)
          const remainingPlayer = game.players[0];
          if (remainingPlayer && remainingPlayer.socketId) {
             io.to(remainingPlayer.socketId).emit("opponent-left");
             console.log(`Notified opponent ${remainingPlayer.name} that their partner left.`);
          }
          // Update game status in Firestore to 'waiting_for_resume'
          try {
              await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                  status: 'waiting_for_resume',
                  lastUpdated: Timestamp.now()
              });
              console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to leave.`);
          } catch (error) {
              console.error("Error updating game status to 'waiting_for_resume' on leave:", error);
          }
        }
      }
    }
    // Attempt to re-add player to lobby list if they were logged in (all players now)
    if (userId) {
        // Ensure the player is in the global 'players' list and not marked as being in a game
        let existingPlayerInLobby = players.find(p => p.userId === userId);
        if (existingPlayerInLobby) {
            existingPlayerInLobby.id = socket.id; // Update their socket if needed
        } else {
            const userNameForLobby = user ? user.displayName : `User_${userId.substring(0, 8)}`;
            players.push({ id: socket.id, userId: userId, name: userNameForLobby });
        }
    }
    // Always update lobby list to reflect changes
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));
  });


  // Socket Disconnect Event (e.g., browser tab closed, network drop)
  socket.on("disconnect", async () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const user = socket.request.session?.passport?.user || null;
    const disconnectedUserId = user ? user.id : null;

    if (disconnectedUserId) {
        // Remove from userSocketMap as this socket is no longer active for this user
        delete userSocketMap[disconnectedUserId];
        console.log(`User ${disconnectedUserId} socket removed from map.`);
    }

    // Remove from lobby player list (by socket.id or userId if known)
    // Filter out players whose current socket matches the disconnected one, or if they are the disconnected user and not in a game
    players = players.filter(p => !(p.id === socket.id || (disconnectedUserId && p.userId === disconnectedUserId && !userGameMap[p.userId])));
    io.emit("players-list", players.map(p => ({ id: p.id, name: p.name })));


    // Check if the disconnected user was in a game
    if (disconnectedUserId && userGameMap[disconnectedUserId]) {
        const gameId = userGameMap[disconnectedUserId];
        const game = games[gameId];

        if (game) {
            // Find and update the disconnected player's socketId within the game object
            const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
            if (disconnectedPlayerInGame) {
                disconnectedPlayerInGame.socketId = null; // Mark their socket as null
                console.log(`Player ${disconnectedPlayerInGame.name} (${disconnectedUserId}) in game ${gameId} disconnected (socket marked null).`);
            }

            // Check if both players are now disconnected (i.e., both have null socketIds)
            const allPlayersDisconnected = game.players.every(p => p.socketId === null);

            if (allPlayersDisconnected) {
                // If both players are disconnected, end the game
                game.players.forEach(p => delete userGameMap[p.userId]); // Clear userGameMap for both
                delete games[gameId];
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                        status: 'completed',
                        lastUpdated: Timestamp.now()
                    });
                    console.log(`Game ${gameId} status set to 'completed' in Firestore as all players disconnected.`);
                } catch (error) {
                    console.error("Error updating game status to 'completed' on total disconnect:", error);
                }
                console.log(`Game ${gameId} deleted from memory (both disconnected).`);
            } else {
                // One player disconnected, but the other might still be connected or might reconnect
                const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                    console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
                }
                // Update game status in Firestore to 'waiting_for_resume'
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                        status: 'waiting_for_resume',
                        lastUpdated: Timestamp.now()
                    });
                    console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to disconnect.`);
                } catch (error) {
                    console.error("Error updating game status to 'waiting_for_resume' on disconnect:", error);
                }
            }
        } else {
            delete userGameMap[disconnectedUserId]; // Game wasn't in memory, just clear the userGameMap entry
            console.log(`User ${disconnectedUserId} was mapped to game ${gameId} but game not in memory. Clearing userGameMap.`);
        }
    }
  });

});

// --- Server Startup ---
const PORT = process.env.PORT || 3001; // Use Render's PORT env var, or 3001 for local dev
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
