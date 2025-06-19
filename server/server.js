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
// Re-added Facebook client ID and secret declaration here
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Declare `db`, `sessionMiddleware`, and `io` variables here ===
let db;
let sessionMiddleware;
let io; // Declare io here so it's accessible globally


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
    resave: true, // Changed to true for testing session persistence
    saveUninitialized: false,
    store: new FirestoreStore({ // Instantiate FirestoreStore with 'new'
      dataset: firestoreClient, // Pass the Firestore client instance
      kind: 'express-sessions', // Optional: collection name for sessions, defaults to 'express-sessions'
    }),
    cookie: {
      sameSite: "none",
      secure: true,
      // 'domain' property removed for better compatibility with Render deployments
      maxAge: 1000 * 60 * 60 * 24 // 24 hours (example)
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
      console.log(`[Socket.IO Auth] Socket ${socket.id} connecting.`);
      // Mock a 'res' object for session and passport middleware compatibility
      const dummyRes = {
          writeHead: () => {}, // Add no-op writeHead
          end: () => {} // Add no-op end
      };
      socket.request.res = dummyRes;

      // Apply session middleware
      sessionMiddleware(socket.request, socket.request.res, () => {
          console.log(`[Socket.IO Auth] After sessionMiddleware for ${socket.id}. Session ID: ${socket.request.sessionID}`);
          console.log(`[Socket.IO Auth] Session object exists: ${!!socket.request.session}`);
          console.log(`[Socket.IO Auth] Session.passport exists: ${!!socket.request.session?.passport}`);
          console.log(`[Socket.IO Auth] Session.passport.user: ${JSON.stringify(socket.request.session?.passport?.user)}`);

          // Apply passport.initialize
          passport.initialize()(socket.request, socket.request.res, () => {
              // Apply passport.session
              passport.session()(socket.request, socket.request.res, () => {
                  console.log(`[Socket.IO Auth] After passport.session() for ${socket.id}. req.user: ${JSON.stringify(socket.request.user)}`);
                  if (socket.request.user) {
                      console.log(`[Socket.IO Auth] User authenticated via session: ${socket.request.user.displayName || socket.request.user.id}`);
                  } else {
                      console.log(`[Socket.IO Auth] User NOT authenticated after passport.session() for ${socket.id}.`);
                  }
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


// These variables are now properly declared at the top of the file
// const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
// const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

// === Passport config ===
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  // console.log(`[Passport Callback] Google Strategy: Received profile for user ID: ${profile.id}, Name: ${profile.displayName}`); // Removed sensitive log
  // Store only the necessary profile info in the session
  done(null, { id: profile.id, displayName: profile.displayName }); // Store object with ID and displayName
}));

passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID, // Correctly using the declared variable
  clientSecret: FACEBOOK_CLIENT_SECRET, // Correctly using the declared variable
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  // console.log(`[Passport Callback] Facebook Strategy: Received profile for user ID: ${profile.id}, Name: ${profile.displayName}`); // Removed sensitive log
  cb(null, { id: profile.id, displayName: profile.displayName }); // Store object with ID and displayName
}));


// Passport Serialization/Deserialization
passport.serializeUser((user, done) => {
  // user here is the object { id: profile.id, displayName: profile.displayName }
  console.log(`[Passport] serializeUser: Serializing user - ID: ${user.id}, Name: ${user.displayName}`);
  done(null, user); // Store the entire user object in the session
});

passport.deserializeUser((user, done) => {
  // user here is the object { id: profile.id, displayName: profile.displayName }
  console.log(`[Passport] deserializeUser: Deserializing user - ID: ${user.id}, Name: ${user.displayName}`);
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
    console.log(`[Session Save] Attempting to save session after Google auth.`);
    console.log(`[Session Save] Session before save (Google): ${JSON.stringify(req.session)}`);
    console.log(`[Session Save] req.session.passport before save (Google): ${JSON.stringify(req.session?.passport)}`);

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
    console.log(`[Session Save] Attempting to save session after Facebook auth.`);
    console.log(`[Session Save] Session before save (Facebook): ${JSON.stringify(req.session)}`);
    console.log(`[Session Save] req.session.passport before save (Facebook): ${JSON.stringify(req.session?.passport)}`);

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
          sameSite: 'none'
      }); // Clear the session cookie from the client
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

// Login Check Route
app.get("/me", (req, res) => {
  console.log("------------------- /me Request Received -------------------");
  console.log("Is Authenticated (req.isAuthenticated()):", req.isAuthenticated());
  console.log("User in session (req.user):", req.user); // This is the user object from deserializeUser: { id, displayName }
  console.log("Session ID (req.sessionID):", req.sessionID);
  console.log("Session object (req.session):", req.session);

  if (req.isAuthenticated() && req.user) {
    res.json({ user: req.user }); // req.user now contains id and displayName
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
  console.log("------------------------------------------------------------");
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});


// --- Game Logic ---

// Game Constants
const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;

// Global Game Data Structures
let players = []; // Lobby players: { id: socket.id, userId, name }
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
  // This ensures req.session and req.user are available in Socket.IO handlers
  if (socket.request.session && socket.request.session.passport && socket.request.session.passport.user) {
    // req.user is now the full user object { id, displayName }
    const user = socket.request.session.passport.user;
    const userId = user.id;
    const userName = user.displayName;

    console.log(`User ${userName} (${userId}) (re)connected. Socket ID: ${socket.id}`);

    // Update user-to-socket mapping
    userSocketMap[userId] = socket.id;

    // Handle rejoining an existing game if user was previously in one
    if (userGameMap[userId]) {
        const gameId = userGameMap[userId];
        const game = games[gameId];

        if (game) {
            const playerInGame = game.players.find(p => p.userId === userId);
            if (playerInGame) {
                // Update the player's socketId in the game object
                playerInGame.socketId = socket.id;
                console.log(`Re-associated user ${playerInGame.name} (${userId}) in game ${gameId} with new socket ID ${socket.id}`);

                // Prepare and send the full game state to the reconnected player
                const opponentPlayer = game.players.find(op => op.userId !== userId);
                const dataForReconnectedPlayer = {
                    gameId: game.gameId,
                    playerNumber: playerInGame.number,
                    board: JSON.stringify(game.board), // Send serialized board
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                };
                // Emit "game-start" to fully re-initialize their game view on the client
                socket.emit("game-start", dataForReconnectedPlayer);
                console.log(`Emitted game-start to reconnected user ${playerInGame.name}`);

                // Optionally, notify the opponent that their partner reconnected
                if (opponentPlayer && opponentPlayer.socketId) {
                    io.to(opponentPlayer.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                }
            }
        } else {
            // Game no longer exists on server, remove from userGameMap
            delete userGameMap[userId];
            console.log(`Game ${gameId} for user ${userId} no longer exists, clearing map.`);
        }
    }
  } else {
      console.log(`Unauthenticated socket ${socket.id} connected.`);
  }

  // Lobby Join Event
  socket.on("join-lobby", (name) => {
    // req.user is now the full user object { id, displayName }
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : name; // Use displayName from Passport if available, else provided name

    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby.");
        console.warn(`Unauthenticated socket ${socket.id} tried to join lobby.`);
        return;
    }

    // Ensure only one entry per userId in the players list, update socket.id if rejoining
    players = players.filter(p => p.userId !== userId);
    players.push({ id: socket.id, userId: userId, name: userName }); // Store userId and current socket.id

    console.log(`Player ${userName} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined", userName); // Send back the name used
    // Emit updated player list to all connected clients in the lobby (not in a game)
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));
  });

  socket.on("request-unfinished-games", async () => {
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const querySnapshot1 = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .where('player1_userId', '==', userId)
            .get();

        const querySnapshot2 = await db.collection(GAMES_COLLECTION_PATH)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .where('player2_userId', '==', userId)
            .get();

        let unfinishedGames = [];

        querySnapshot1.forEach(doc => {
            const gameData = doc.data();
            // Check if this game is currently active in memory with the current socket.id
            const isCurrentlyActiveInMemory = Object.values(games).some(g =>
                g.gameId === gameData.gameId &&
                g.players.some(p => p.userId === userId && p.socketId === socket.id)
            );

            if (!isCurrentlyActiveInMemory) {
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    // Send serialized board here if needed for preview or full resume on client
                    board: gameData.board, // Already stored as string in Firestore, send as is
                    opponentName: gameData.player2_name,
                    myPlayerNumber: 1,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                });
            }
        });

        querySnapshot2.forEach(doc => {
            const gameData = doc.data();
            // Check if this game is currently active in memory with the current socket.id
            const isCurrentlyActiveInMemory = Object.values(games).some(g =>
                g.gameId === gameData.gameId &&
                g.players.some(p => p.userId === userId && p.socketId === socket.id)
            );

            if (!isCurrentlyActiveInMemory) {
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    // Send serialized board here if needed for preview or full resume on client
                    board: gameData.board, // Already stored as string in Firestore, send as is
                    opponentName: gameData.player1_name,
                    myPlayerNumber: 2,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                });
            }
        });

        // Filter for unique games (a user might be player1 in one doc and player2 in another for the same game)
        const uniqueGames = Array.from(new Map(unfinishedGames.map(item => [item.gameId, item])).values());

        socket.emit("receive-unfinished-games", uniqueGames);
        console.log(`Sent ${uniqueGames.length} unfinished games to user ${userName}.`);

    } catch (error) {
        console.error("Error fetching unfinished games for user:", userId, error);
        socket.emit("join-error", "Failed to load your unfinished games.");
    }
  });

  socket.on("resume-game", async ({ gameId }) => {
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
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

        if (gameData.player1_userId !== userId && gameData.player2_userId !== userId) {
            socket.emit("join-error", "You are not a participant in this game.");
            return;
        }

        // Check if the game is already in memory
        if (games[gameId]) {
            const existingGame = games[gameId];
            const playerInExistingGame = existingGame.players.find(p => p.userId === userId);

            if (playerInExistingGame && playerInExistingGame.socketId === socket.id) {
                // Player is trying to resume a game they are already actively connected to
                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: JSON.stringify(existingGame.board), // Send serialized board
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`User ${userName} re-sent active game state for game ${gameId}.`);
                return;
            } else if (playerInExistingGame && playerInExistingGame.socketId !== socket.id) {
                // User is in the game but with an old socket ID, update it
                playerInExistingGame.socketId = socket.id;
                // Update global player list entry as well if it exists
                const globalPlayerEntry = players.find(p => p.userId === userId);
                if (globalPlayerEntry) globalPlayerEntry.id = socket.id;

                const opponentPlayer = existingGame.players.find(op => op.userId !== userId);
                socket.emit("opponent-reconnected", { name: userName }); // Notify client that opponent reconnected
                socket.emit("game-start", {
                    gameId: existingGame.gameId,
                    playerNumber: playerInExistingGame.number,
                    board: JSON.stringify(existingGame.board), // Send serialized board
                    turn: existingGame.turn,
                    scores: existingGame.scores,
                    bombsUsed: existingGame.bombsUsed,
                    gameOver: existingGame.gameOver,
                    opponentName: opponentPlayer ? opponentPlayer.name : "Opponent"
                });
                console.log(`User ${userName} re-associated socket ID for active game ${gameId}.`);
                return;
            } else {
                 // User tried to resume but another player is already connected with this game in memory
                 socket.emit("join-error", "Game is already active in memory for another player or user is in another game.");
                 console.warn(`User ${userName} tried to resume game ${gameId} but it's already active or user is in another game.`);
                 return;
            }
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

        // Find or create player objects for the in-memory game structure
        let player1 = players.find(p => p.userId === gameData.player1_userId);
        if (!player1) {
            // If player not in current lobby list, create a temporary entry for the game
            player1 = {
                id: (gameData.player1_userId === userId) ? socket.id : null, // Set socket.id if this is the current user
                userId: gameData.player1_userId,
                name: gameData.player1_name,
                number: 1,
                socketId: (gameData.player1_userId === userId) ? socket.id : null,
            };
            players.push({ id: player1.id, userId: player1.userId, name: player1.name }); // Add to global players list
        } else {
            // Update existing player entry
            player1.id = (gameData.player1_userId === userId) ? socket.id : player1.id;
            player1.socketId = (gameData.player1_userId === userId) ? socket.id : player1.socketId;
        }

        let player2 = players.find(p => p.userId === gameData.player2_userId);
        if (!player2) {
            player2 = {
                id: (gameData.player2_userId === userId) ? socket.id : null,
                userId: gameData.player2_userId,
                name: gameData.player2_name,
                number: 2,
                socketId: (gameData.player2_userId === userId) ? socket.id : null,
            };
            players.push({ id: player2.id, userId: player2.userId, name: player2.name }); // Add to global players list
        } else {
            player2.id = (gameData.player2_userId === userId) ? socket.id : player2.id;
            player2.socketId = (gameData.player2_userId === userId) ? socket.id : player2.socketId;
        }

        game.players = [player1, player2];
        games[gameId] = game; // Add game to in-memory active games

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
        }

        // Update lobby player list
        io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

    } catch (error) {
        console.error("Error resuming game:", error);
        socket.emit("join-error", "Failed to resume game. " + error.message);
    }
  });


  // Invite Player Event
  socket.on("invite-player", (targetSocketId) => {
    const inviterPlayer = players.find((p) => p.id === socket.id);
    const invitedPlayer = players.find((p) => p.id === targetSocketId);

    if (!inviterPlayer || !invitedPlayer || userGameMap[inviterPlayer.userId] || userGameMap[invitedPlayer.userId]) {
      console.warn(`Invite failed: Inviter or invitee not found or already in game. Inviter: ${inviterPlayer?.name}, Invitee: ${invitedPlayer?.name}`);
      return; // Invalid invite or already in game
    }

    io.to(invitedPlayer.id).emit("game-invite", {
      fromId: inviterPlayer.id,
      fromName: inviterPlayer.name,
    });
    console.log(`Invite sent from ${inviterPlayer.name} to ${invitedPlayer.name}`);
  });

  // Respond to Invite Event
  socket.on("respond-invite", async ({ fromId, accept }) => {
    const respondingPlayer = players.find((p) => p.id === socket.id);
    const inviterPlayer = players.find((p) => p.id === fromId);

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

      // Save game state to Firestore (with serialized board)
      try {
          const serializedBoard = JSON.stringify(game.board); // Serialize board for Firestore
          console.log(`[Firestore] Attempting to save new game ${game.gameId} to Firestore.`);
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              gameId: game.gameId,
              board: serializedBoard, // Save serialized board
              player1_userId: inviterPlayer.userId,
              player2_userId: respondingPlayer.userId,
              player1_name: inviterPlayer.name,
              player2_name: respondingPlayer.name,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              status: 'active',
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          });
          console.log(`Game ${gameId} saved to Firestore.`);
      } catch (error) {
          console.error("Error saving new game to Firestore:", error); // Log the full error object
          io.to(inviterPlayer.id).emit("join-error", "Failed to start game (DB error).");
          io.to(respondingPlayer.id).emit("join-error", "Failed to start game (DB error).");
          delete games[gameId]; // Clean up in-memory game if DB save fails
          delete userGameMap[inviterPlayer.userId];
          delete userGameMap[respondingPlayer.userId];
          return;
      }

      // Remove players from the general lobby list as they are now in a game
      players = players.filter(p => !userGameMap[p.userId]);
      io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

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

    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
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

    // Check for game restart condition (first click on blank tile)
    const isBlankTile = tile.adjacentMines === 0;
    const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0; // Check initial state

    if (isBlankTile && noFlagsRevealedYet) {
      console.log(`[GAME RESTART TRIGGERED] Player ${player.name} (${player.userId}) hit a blank tile at ${x},${y} before any flags were revealed. Restarting game ${gameId}.`);

      // Reset game state properties within the existing game object
      game.board = generateBoard(); // Generate a brand new board
      game.scores = { 1: 0, 2: 0 }; // Reset scores
      game.bombsUsed = { 1: false, 2: false }; // Reset bomb usage
      game.turn = 1; // Reset turn to player 1
      game.gameOver = false; // Game is no longer over

      try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            board: serializedBoard, // Update with serialized board
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            status: 'active',
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null
        });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
      } catch (error) {
          console.error("Error restarting game in Firestore:", error); // Log the full error object
      }

      // Emit "game-restarted" with full game data for both players, using their current socketId
      game.players.forEach(p => {
          if (p.socketId) { // Only emit if the player has a currently active socket
              const opponentPlayer = game.players.find(op => op.userId !== p.userId);
              io.to(p.socketId).emit("game-restarted", {
                  gameId: game.gameId,
                  playerNumber: p.number,
                  board: JSON.stringify(game.board), // Send serialized board to client
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
      return; // Stop further processing for this click
    }

    revealRecursive(game.board, x, y); // Normal reveal
    game.turn = game.turn === 1 ? 2 : 1; // Switch turn

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
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (tile-click).`);
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error); // Log the full error object
    }

    // Only emit board-update if the game was NOT restarted by this click
    // If the game was restarted, the 'game-restarted' event handles the update
    game.players.forEach(p => {
        if (p.socketId) { // Only emit if the player has a currently active socket
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

    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
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

    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
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
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : null
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
    
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
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
            status: 'active',
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
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
    const userId = user ? user.id : null;

    if (game && userId) {
      const playerIndex = game.players.findIndex(p => p.userId === userId);
      if (playerIndex !== -1) {
        // Remove from userGameMap
        delete userGameMap[userId];
        console.log(`User ${userId} (${game.players[playerIndex].name}) left game ${gameId}.`);

        // Remove the player from the game's player list
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
    // Attempt to re-add player to lobby list if they were logged in
    if (userId) {
        // Filter out any old entries for this user, then add the current one
        players = players.filter(p => p.userId !== userId);
        const userName = user ? user.displayName : `User_${userId.substring(0, 8)}`;
        players.push({ id: socket.id, userId: userId, name: userName });
    }
    // Always update lobby list to reflect changes
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));
  });


  // Socket Disconnect Event (e.g., browser tab closed, network drop)
  socket.on("disconnect", async () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const user = socket.request.session.passport ? socket.request.session.passport.user : null;
    const disconnectedUserId = user ? user.id : null;

    if (disconnectedUserId) {
        // Remove from userSocketMap as this socket is no longer active for this user
        // Note: A new socket for the same user might connect shortly.
        delete userSocketMap[disconnectedUserId];
        console.log(`User ${disconnectedUserId} socket removed from map.`);
    }

    // Remove from lobby player list (by socket.id or userId if known)
    players = players.filter(p => p.id !== socket.id && p.userId !== disconnectedUserId);
    io.emit("players-list", players.filter(p => !userGameMap[p.userId]).map(p => ({ id: p.id, name: p.name })));

    // Check if the disconnected user was in a game
    for (const gameId in games) {
        const game = games[gameId];
        // Find player by either socketId (direct match) or userId (more robust)
        const playerIndex = game.players.findIndex(p => p.socketId === socket.id || (disconnectedUserId && p.userId === disconnectedUserId));
        if (playerIndex !== -1) {
            console.log(`Player ${game.players[playerIndex].name} (${game.players[playerIndex].userId}) disconnected from game ${gameId}.`);
            
            // Remove from userGameMap for this user
            if (game.players[playerIndex].userId) {
                delete userGameMap[game.players[playerIndex].userId];
            }

            // Remove the player's socketId from the in-memory game object, but keep the player object.
            // This allows the player to potentially reconnect and resume the game.
            // game.players[playerIndex].socketId = null; // No need to explicitly set to null, just update in map


            // Remove the player from the game's player list
            game.players.splice(playerIndex, 1);


            if (game.players.length === 0) {
                // If no players left in the game, delete the game from memory and Firestore
                delete games[gameId];
                try {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                        status: 'completed', // Mark as completed if all players left
                        lastUpdated: Timestamp.now()
                    });
                    console.log(`Game ${gameId} status set to 'completed' in Firestore as all players left after disconnect.`);
                } catch (error) {
                    console.error("Error updating game status to 'completed' on disconnect (all players left):", error);
                }
                console.log(`Game ${gameId} deleted from memory.`);
            } else {
                // Notify the remaining player if any
                const remainingPlayer = game.players[0];
                if (remainingPlayer && remainingPlayer.socketId) {
                    io.to(remainingPlayer.socketId).emit("opponent-left");
                    console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
                } else {
                    console.warn(`Remaining player in game ${gameId} has no active socket to notify.`);
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
        }
    }
  });

});

// --- Server Startup ---
const PORT = process.env.PORT || 3001; // Use Render's PORT env var, or 3001 for local dev
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
