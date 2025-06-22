// server.js

const express = require("express");
const fetch = require('node-fetch'); // You might need to import fetch if not already available globally in your Node.js version
const router = express.Router(); // Assuming you're using express.Router or directly app.get
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
// It is then instantiated with 'new', and does NOT take 'session` directly in the require call.
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
app.use(express.json()); // Enable parsing of JSON body for guest login
// IMPORTANT: Add this line to trust proxy headers when deployed to Render
app.set('trust proxy', 1); 
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID, Guest ID)
const userGameMap = {};   // Maps userId to the gameId they are currently in

// Configure CORS for Express
// MUST match your frontend Render URL exactly
app.use(
  cors({
    origin: "https://minesweeper-flags-frontend.onrender.com", // Your frontend URL
    credentials: true, // Allow cookies to be sent cross-origin
  })
);

// Add this route to your existing Express app
router.get('/api/get-client-ip', async (req, res) => {
    try {
        // Option 1: Get IP from request headers (most common when proxied)
        // This attempts to get the IP from common proxy headers like X-Forwarded-For
        // If your server is directly exposed, req.ip or req.connection.remoteAddress might work.
        // For Render.com, 'x-forwarded-for' is usually reliable.
        let clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        // If clientIp is an array (e.g., from X-Forwarded-For with multiple IPs), take the first one
        if (Array.isArray(clientIp)) {
            clientIp = clientIp[0];
        }

        // If clientIp is an IPv6 address like '::1' or '::ffff:127.0.0.1', or includes port
        if (clientIp && clientIp.includes(':') && !clientIp.startsWith('::')) { // IPv6 with port
            clientIp = clientIp.split(':').slice(0, -1).join(':');
        }
        if (clientIp === '::1' || clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
            // This means the request came from localhost or a direct local connection to your backend
            // In a production environment behind a proxy (like Render.com), this is usually not the case.
            // If it is, you might still need to call ipify.org from the backend.
            console.warn("Client IP is localhost. Attempting to fetch public IP via ipify.org from backend.");
            const response = await fetch('https://api.ipify.org?format=json');
            if (!response.ok) {
                throw new Error(`Failed to fetch public IP from ipify.org: ${response.status}`);
            }
            const data = await response.json();
            clientIp = data.ip;
        }

        // If for some reason clientIp is still not resolved, fall back to ipify.org directly from backend
        if (!clientIp || clientIp.includes('::ffff:')) { // Common pattern for IPv4 mapped IPv6 or if still local
             console.warn("Client IP not resolved from headers or is IPv6 mapped IPv4. Falling back to ipify.org from backend.");
             const response = await fetch('https://api.ipify.org?format=json');
             if (!response.ok) {
                 throw new Error(`Failed to fetch public IP from ipify.org: ${response.status}`);
             }
             const data = await response.json();
             clientIp = data.ip;
        }

        if (!clientIp) {
            throw new Error("Could not determine client IP.");
        }

        res.json({ ip: clientIp });

    } catch (error) {
        console.error('Backend IP fetch error:', error);
        res.status(500).json({ error: 'Failed to retrieve client IP address', details: error.message });
    }
});

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

// NEW: Timer Constants
const INITIAL_PLAYER_TIME = 2 * 60; // 2 minutes in seconds
const TIME_PER_MOVE = 10; // 10 seconds per move bonus

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
      // REMOVED `domain` property as it can cause issues with different subdomains on Render
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
        // Redirect to a failure page with an error message
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      console.log(`[Session Save] Session successfully saved after Google auth. New Session ID: ${req.sessionID}`);
      
      // NEW: Redirect the pop-up window itself back to the frontend with data in hash fragment
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
      // Encode user data as JSON and put it in the hash fragment
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Complete</title>
          <script>
            window.onload = function() {
              const userData = ${JSON.stringify(userData)};
              window.location.href = 'https://minesweeper-flags-frontend.onrender.com/auth/callback#' + encodeURIComponent(JSON.stringify(userData));
            };
          </script>
        </head>
        <body>
          <p>Authentication successful. Redirecting...</p>
        </body>
        </html>
      `);
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
        // Redirect to a failure page with an error message
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      console.log(`[Session Save] Session successfully saved after Facebook auth. New Session ID: ${req.sessionID}`);
      
      // NEW: Redirect the pop-up window itself back to the frontend with data in hash fragment
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
      // Encode user data as JSON and put it in the hash fragment
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Complete</title>
          <script>
            window.onload = function() {
              const userData = ${JSON.stringify(userData)};
              window.location.href = 'https://minesweeper-flags-frontend.onrender.com/auth/callback#' + encodeURIComponent(JSON.stringify(userData));
            };
          </script>
        </head>
        <body>
          <p>Authentication successful. Redirecting...</p>
        </body>
        </html>
      `);
    });
  }
);

// NEW: Guest Login Route
app.post("/auth/guest", (req, res) => {
    const { guestId } = req.body;
    if (!guestId) {
        return res.status(400).json({ message: "Guest ID is required." });
    }

    // Set user data directly in the session for guest
    req.session.passport = { user: { id: guestId, displayName: `Guest_${guestId.substring(0, 8)}` } };

    req.session.save((err) => {
        if (err) {
            console.error("Error saving guest session:", err);
            return res.status(500).json({ message: "Failed to create guest session." });
        }
        console.log(`Guest session saved: ${guestId}`);
        res.status(200).json({ user: req.session.passport.user });
    });
});


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
          // REMOVED `domain` property
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
  console.log("User in session (req.user):", req.user);
  console.log("Session ID (req.sessionID):", req.sessionID);
  console.log("Session object (req.session):", req.session);
  console.log("Passport data in session:", req.session?.passport);


  if (req.isAuthenticated() && req.user) {
    res.json({ user: req.user }); // req.user now contains id and displayName
  } else if (req.session?.passport?.user) { // Check for guest user explicitly if Passport.js didn't authenticate
      res.json({ user: req.session.passport.user });
  }
  else {
    res.status(401).json({ error: "Not authenticated" });
  }
  console.log("------------------------------------------------------------");
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});


// Global Game Data Structures
let players = []; // Lobby players: [{ id: socket.id, userId, name }]
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], board, scores, bombsUsed, turn, gameOver, lastClickedTile, isTimedGame, playerTimes, lastMoveTime }

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

// Helper to emit the filtered list of players in the lobby
const emitLobbyPlayersList = () => {
    console.log(`[emitLobbyPlayersList] Full 'players' array before filtering: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);
    console.log(`[emitLobbyPlayersList] Current 'userGameMap': ${JSON.stringify(userGameMap)}`);

    const lobbyPlayers = players;
    io.emit("players-list", lobbyPlayers.map(p => ({ id: p.id, name: p.name })));
    console.log(`[emitLobbyPlayersList] Emitted players-list to lobby. Total lobby players: ${lobbyPlayers.length}. Visible players: ${JSON.stringify(lobbyPlayers.map(p => p.name))}`);
};


// === Socket.IO Connection and Game Events ===
io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Passport.js attaches session to socket.request
  const user = socket.request.session?.passport?.user || null;
  const userId = user ? user.id : null;
  const userName = user ? user.displayName : null;

  if (userId) {
    console.log(`[Connect] User ${userName} (${userId}) connected. Socket: ${socket.id}. Currently in game map? ${userGameMap[userId] ? 'Yes' : 'No'}.`);

    // Always update user-to-socket mapping with the latest socket ID
    userSocketMap[userId] = socket.id;
    // Emit this event *after* userSocketMap is updated and userId is confirmed
    socket.emit('authenticated-socket-ready');

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
                        lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null }, // Load lastClickedTile
                        isTimedGame: gameData.isTimedGame || false, // Load isTimedGame
                        playerTimes: gameData.playerTimes || { 1: 0, 2: 0 }, // Load playerTimes
                        lastMoveTime: gameData.lastMoveTime || 0, // Load lastMoveTime
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
                        doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).then(() => {
                            console.log(`Game ${gameId} status updated to 'active' in Firestore.`);
                        }).catch(e => console.error("Error updating game status on resume:", e));
                        
                        // If resuming a timed game, DO NOT reset lastMoveTime.
                        // It should continue from where it left off, reflecting the continuous timer.
                        if (game.isTimedGame) {
                            console.log(`[Resume] Timed game ${gameId} resumed. lastMoveTime remains as loaded for turn ${game.turn}.`);
                        }
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
                            lastClickedTile: game.lastClickedTile, // Include lastClickedTile
                            isTimedGame: game.isTimedGame, // Include isTimedGame
                            playerTimes: game.playerTimes, // Include playerTimes
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
                    emitLobbyPlayersList(); // Use the helper
                } else {
                    delete userGameMap[userId]; // Game not found or invalid status, clear map
                    console.log(`Game ${gameId} for user ${userId} not found or invalid status in Firestore. Clearing map.`);
                    emitLobbyPlayersList(); // Re-emit if userGameMap changed
                }
            }).catch(e => console.error("Error fetching game from Firestore on reconnect:", e));
        } else { // Game found in memory
            const playerInGame = game.players.find(p => p.userId === userId);
            if (playerInGame) {
                playerInGame.socketId = socket.id; // Ensure current socketId is used in game object
                const opponentPlayer = game.players.find(op => op.userId !== userId);

                // If resuming a timed game, DO NOT reset lastMoveTime.
                // It should continue from where it left off, reflecting the continuous timer.
                if (existingGame.isTimedGame && existingGame.turn === currentPlayerInGame.number) {
                    console.log(`[Resume] Timed game ${gameId} resumed. lastMoveTime remains as loaded for turn ${existingGame.turn}.`);
                }

                // Re-send game state to ensure client is up-to-date
                io.to(playerInGame.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: playerInGame.number,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    lastClickedTile: game.lastClickedTile, // Include lastClickedTile
                    isTimedGame: game.isTimedGame, // Include isTimedGame
                    playerTimes: game.playerTimes, // Include playerTimes
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
      // No `authenticated-socket-ready` emitted for unauthenticated sockets
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

    console.log(`[Join Lobby] Player ${userName} (${userId}) attempting to join lobby with socket ID ${socket.id}.`);
    console.log(`[Join Lobby] Players before filter: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);
    
    // Ensure userSocketMap is updated
    userSocketMap[userId] = socket.id;

    // Ensure only one entry per userId in the players list, update socket.id if rejoining
    players = players.filter(p => p.userId !== userId);
    console.log(`[Join Lobby] Players after filter for existing userId: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);

    players.push({ id: socket.id, userId: userId, name: userName }); // Store userId and current socket.id
    console.log(`[Join Lobby] Players after push: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);


    console.log(`Player ${userName} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined", userName); // Send back the name used
    // Emit updated player list to all connected clients in the lobby (all players now)
    console.log(`[Join Lobby] Calling emitLobbyPlayersList. Current userGameMap: ${JSON.stringify(userGameMap)}`);
    emitLobbyPlayersList(); // Use the helper
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
            .where('gameOver', '==', false) // Only fetch games that are NOT over
            .where('status', 'in', ['active', 'waiting_for_resume']) // Fetch active or waiting games
            .get();

        let unfinishedGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            // Check if the current user is part of this game
            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;

            if (isPlayer1 || isPlayer2) {
                // Always add the game to the unfinishedGames list if the current user is a participant
                // and the game is active or waiting for resume, regardless of current socket activity.
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    board: gameData.board, // Send serialized board for potential client-side preview
                    opponentName: isPlayer1 ? gameData.player2_name : gameData.player1_name,
                    myPlayerNumber: isPlayer1 ? 1 : 2,
                    status: gameData.status,
                    isTimedGame: gameData.isTimedGame || false, // Include isTimedGame
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A'
                });
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

  // Ensure this user's socket is properly mapped before proceeding
  // This is crucial for handling re-connections from the same user but new socket
  userSocketMap[userId] = socket.id;

  try {
    const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameDocRef.get();

    if (!gameDoc.exists) {
      socket.emit("join-error", "Game not found or already ended.");
      // Also, if a game is not found, ensure userGameMap doesn't point to it
      if (userGameMap[userId] === gameId) {
          delete userGameMap[userId];
      }
      return;
    }

    const gameData = gameDoc.data();

    // Verify that the resuming user is one of the players in this game
    if (gameData.player1_userId !== userId && gameData.player2_userId !== userId) {
      socket.emit("join-error", "You are not a participant in this game.");
      return;
    }

    // Determine current player's number and opponent's data from Firestore data
    const currentPlayerNumber = gameData.player1_userId === userId ? 1 : 2;
    const opponentUserId = gameData.player1_userId === userId ? gameData.player2_userId : gameData.player1_userId;
    const opponentName = gameData.player1_userId === userId ? gameData.player2_name : gameData.player1_name;

    // Check if the game is already in memory
    if (games[gameId]) {
      const existingGame = games[gameId];

      // Step 1: Update the in-memory game's player socket IDs based on the global userSocketMap.
      // This ensures the most current connection status for both players.
      existingGame.players.forEach(player => {
          player.socketId = userSocketMap[player.userId] || null;
      });

      const currentPlayerInGame = existingGame.players.find(p => p.userId === userId);
      const opponentPlayerInGame = existingGame.players.find(op => op.userId !== userId);

      // Verify current player's presence in the in-memory game's player list
      if (!currentPlayerInGame) {
          socket.emit("join-error", "Internal error: You are a participant but not found in in-memory game players.");
          console.error(`Error: User ${userId} is a game participant but not in existingGame.players array.`);
          return;
      }

      // If the current player's socket is now correctly set to the active socket,
      // it means they are successfully connected/reconnected to their game slot.
      if (currentPlayerInGame.socketId === socket.id) {
          // If resuming a timed game, DO NOT reset lastMoveTime.
          // The timer should continue running even during disconnect.
          if (existingGame.isTimedGame && existingGame.turn === currentPlayerInGame.number) {
            console.log(`[Resume] Timed game ${gameId} resumed. lastMoveTime remains as loaded for turn ${existingGame.turn}.`);
          }

          // Emit the game state to the resuming player
          io.to(currentPlayerInGame.socketId).emit("game-start", {
              gameId: existingGame.gameId,
              playerNumber: currentPlayerNumber, // Use the derived number
              board: JSON.stringify(existingGame.board),
              turn: existingGame.turn,
              scores: existingGame.scores,
              bombsUsed: existingGame.bombsUsed,
              gameOver: existingGame.gameOver,
              lastClickedTile: existingGame.lastClickedTile, // Include lastClickedTile
              isTimedGame: existingGame.isTimedGame, // Include isTimedGame
              playerTimes: existingGame.playerTimes, // Include playerTimes
              opponentName: opponentName // Use the derived name
          });
          console.log(`User ${userName} (re)connected to game ${gameId} from in-memory state.`);

          // Notify the opponent if they are also connected with an active socket
          if (opponentPlayerInGame && opponentPlayerInGame.socketId) {
              io.to(opponentPlayerInGame.socketId).emit("opponent-reconnected", { name: userName });
          }
          return; // Successful resumption, exit
      } else {
          // This case implies the user's userId is mapped to a different active socket
          // for this game, indicating another active session/tab for the same user.
          socket.emit("join-error", "Your game session is active on another connection or tab.");
          console.warn(`User ${userName} tried to resume game ${gameId}, but their socket ID does not match the active one in memory or userSocketMap.`);
          return;
      }
    }


    // If game not in memory, load from Firestore and initialize in memory
    const deserializedBoard = JSON.parse(gameData.board); // Deserialize board from Firestore string

    // Reconstruct the game object for in-memory use
    const game = {
      gameId: gameData.gameId,
      board: deserializedBoard,
      scores: gameData.scores,
      bombsUsed: gameData.bombsUsed,
      turn: gameData.turn,
      gameOver: gameData.gameOver,
      lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null }, // Load lastClickedTile from Firestore
      isTimedGame: gameData.isTimedGame || false, // Load isTimedGame
      playerTimes: gameData.playerTimes || { 1: 0, 2: 0 }, // Load playerTimes
      lastMoveTime: gameData.lastMoveTime || 0, // Load lastMoveTime
      players: [] // Will populate based on who is resuming and who the opponent is
    };

    // Populate players array for the in-memory game object
    const p1UserId = gameData.player1_userId;
    const p2UserId = gameData.player2_userId;

    // Find or create player objects (important for 'players' list and socket mapping)
    let player1 = players.find(p => p.userId === p1UserId);
    if (!player1) {
        player1 = { userId: p1UserId, name: gameData.player1_name, number: 1 };
        // If not found in 'players', consider adding them if 'players' is for all online users
        // Otherwise, just use this temporary object.
        players.push(player1); // Add to online players if they weren't there
    }
    // Assign the current socket ID if this is the resuming player, or get from map for opponent
    player1.socketId = (p1UserId === userId) ? socket.id : (userSocketMap[p1UserId] || null);


    let player2 = players.find(p => p.userId === p2UserId);
    if (!player2) {
        player2 = { userId: p2UserId, name: gameData.player2_name, number: 2 };
        players.push(player2); // Add to online players if they weren't there
    }
    // Assign the current socket ID if this is the resuming player, or get from map for opponent
    player2.socketId = (p2UserId === userId) ? socket.id : (userSocketMap[p2UserId] || null);


    game.players = [player1, player2];
    games[gameId] = game; // Add game to in-memory active games
    
    // Ensure userGameMap is correctly set for both players to this gameId
    userGameMap[p1UserId] = gameId; 
    userGameMap[p2UserId] = gameId;

    // Update Firestore status from 'waiting_for_resume' to 'active'
    if (gameData.status === 'waiting_for_resume') {
      await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
      console.log(`Game ${gameId} status updated to 'active' in Firestore.`);
      
      // If resuming a timed game, DO NOT reset lastMoveTime.
      // The timer should continue running even during disconnect.
      if (game.isTimedGame) {
          console.log(`[Resume] Timed game ${gameId} resumed. lastMoveTime remains as loaded for turn ${game.turn}.`);
      }
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
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile
        isTimedGame: game.isTimedGame, // Include isTimedGame
        playerTimes: game.playerTimes, // Include playerTimes
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
    emitLobbyPlayersList(); // Use the helper

  } catch (error) {
    console.error("Error resuming game:", error);
    socket.emit("join-error", "Failed to resume game. " + error.message);
    // If an error occurs, ensure userGameMap is cleaned up if it was set incorrectly
    if (userGameMap[userId] === gameId) {
        delete userGameMap[userId];
    }
  }
});

  // Invite Player Event
  socket.on("invite-player", ({ targetSocketId, withTimer }) => { // NEW: Receive withTimer
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
      withTimer: withTimer // NEW: Pass withTimer to the invitee
    });
    console.log(`Invite sent from ${inviterPlayer.name} to ${invitedPlayer.name}${withTimer ? ' (with timer)' : ''}`);
  });

  // Respond to Invite Event
  socket.on("respond-invite", async ({ fromId, accept, withTimer }) => { // Changed to accept `withTimer`
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
      const lastClickedTile = { 1: null, 2: null }; // Initialize lastClickedTile for new game

      // Use the received `withTimer` directly
      const isTimedGame = withTimer; 

      let playerTimes = { 1: 0, 2: 0 };
      let lastMoveTime = 0;
      if (isTimedGame) {
          playerTimes = { 1: INITIAL_PLAYER_TIME, 2: INITIAL_PLAYER_TIME };
          lastMoveTime = Date.now(); // Set initial last move time for the first player's turn
      }

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
        lastClickedTile, // Include lastClickedTile in in-memory game object
        isTimedGame, // NEW: Add isTimedGame
        playerTimes, // NEW: Add playerTimes
        lastMoveTime, // NEW: Add lastMoveTime
      };
      games[gameId] = game;

      // Update userGameMap for both players
      userGameMap[inviterPlayer.userId] = gameId;
      userGameMap[respondingPlayer.userId] = gameId;
      console.log(`Game ${gameId} started between ${inviterPlayer.name} (${inviterPlayer.userId}) and ${respondingPlayer.name} (${respondingPlayer.userId}). Is Timed: ${isTimedGame}`);

      // Save game state to Firestore (with serialized board)
      try {
          const serializedBoard = JSON.stringify(game.board); // Serialize board for Firestore
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              gameId: game.gameId,
              board: serializedBoard, // Save serialized board
              player1_userId: inviterPlayer.userId,
              player2_userId: respondingPlayer.userId, // Corrected variable name from responderPlayer to respondingPlayer
              player1_name: inviterPlayer.name,
              player2_name: respondingPlayer.name,   // Corrected variable name from responderPlayer to respondingPlayer
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile, // Save lastClickedTile to Firestore
              isTimedGame: game.isTimedGame, // NEW: Save isTimedGame
              playerTimes: game.playerTimes, // NEW: Save playerTimes
              lastMoveTime: game.lastMoveTime, // NEW: Save lastMoveTime
              status: 'active', // Mark as active
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          }, { merge: true }); // Use merge: true for robustness
          console.log(`Game ${gameId} saved to Firestore.`);
      } catch (error) {
          console.error("Error saving new game to Firestore:", error); // Log the full error object
          io.to(inviterPlayer.id).emit("join-error", "Failed to start game (DB error).");
          io.to(respondingPlayer.id).emit("join-error", "Failed to start game (DB error).");
          delete games[gameId]; // Clean up in-memory game if DB save fails
          delete userGameMap[inviterPlayer.userId];
          delete userGameMap[respondingPlayer.userId];
          emitLobbyPlayersList(); // Re-emit lobby list if game creation failed and players should be available
          return;
      }

      // Remove players from the general lobby list as they are now in a game
      emitLobbyPlayersList(); // Use the helper

      // Emit game-start to both players with their specific player number and opponent name
      io.to(inviterPlayer.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 1,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        isTimedGame: game.isTimedGame, // NEW: Include isTimedGame
        playerTimes: game.playerTimes, // NEW: Include playerTimes
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
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        isTimedGame: game.isTimedGame, // NEW: Include isTimedGame
        playerTimes: game.playerTimes, // NEW: Include playerTimes
        opponentName: inviterPlayer.name,
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: respondingPlayer.name });
      console.log(`Invite from ${inviterPlayer.name} rejected by ${respondingPlayer.name}.`);
      emitLobbyPlayersList(); // Re-emit if invite rejected, to ensure lobby list is accurate
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

    // NEW: Timer Logic - Check time before processing move
    if (game.isTimedGame) {
        const timeElapsedSinceLastMove = Date.now() - game.lastMoveTime; // In milliseconds
        let deduction = (timeElapsedSinceLastMove / 1000) - TIME_PER_MOVE; // In seconds
        
        if (deduction > 0) { // If time taken exceeds bonus time
            game.playerTimes[player.number] -= deduction;
            console.log(`[Timer] Player ${player.number} took ${timeElapsedSinceLastMove / 1000}s. Deducted ${deduction.toFixed(2)}s. Remaining time: ${game.playerTimes[player.number].toFixed(2)}s`);
        }

        if (game.playerTimes[player.number] <= 0) {
            game.playerTimes[player.number] = 0; // Ensure time doesn't go negative on display
            game.gameOver = true;
            const winnerPlayerNumber = player.number === 1 ? 2 : 1;
            const loserPlayerNumber = player.number;
            
            console.log(`[Timer] Player ${loserPlayerNumber} ran out of time in game ${gameId}. Player ${winnerPlayerNumber} wins!`);
            
            // Notify clients about time-out
            game.players.forEach(p => {
                if (p.socketId) {
                    io.to(p.socketId).emit("time-out", { winnerPlayerNumber, loserPlayerNumber });
                }
            });

            // Update Firestore for game over due to time out
            try {
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    status: 'completed',
                    gameOver: true,
                    lastUpdated: Timestamp.now(),
                    winnerId: game.players.find(p => p.number === winnerPlayerNumber).userId,
                    loserId: game.players.find(p => p.number === loserPlayerNumber).userId,
                    lastClickedTile: game.lastClickedTile,
                    isTimedGame: game.isTimedGame,
                    playerTimes: game.playerTimes,
                    lastMoveTime: game.lastMoveTime, // Save final lastMoveTime
                }, { merge: true });
                console.log(`Game ${gameId} status set to 'completed' (time-out) in Firestore.`);
            } catch (error) {
                console.error("Error setting game status to 'completed' (time-out) in Firestore:", error);
            }
            game.players.forEach(p => delete userGameMap[p.userId]);
            emitLobbyPlayersList();
            return; // Exit as game is over
        }
    }


    const tile = game.board[y][x];
    if (tile.revealed) {
        console.warn(`Tile click: Tile ${x},${y} already revealed.`);
        return;
    }

    // Update last clicked tile for the current player
    game.lastClickedTile = { ...game.lastClickedTile, [player.number]: { x, y } };

    // --- Start of Re-ordered and Corrected Logic ---
    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number; // Assign owner to the mine
      game.scores[player.number]++; // Increment score for capturing a mine

      console.log(`[Tile Click] Player ${player.name} revealed a mine at (${x},${y}). New score: ${game.scores[player.number]}`);

      if (checkGameOver(game.scores)) {
          game.gameOver = true;
          // NEW: Set game status to 'completed' in Firestore and clear userGameMap
          try {
              await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                  status: 'completed', // Game is completed
                  gameOver: true,
                  lastUpdated: Timestamp.now(),
                  winnerId: game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId, // Assuming player 1 is index 0, player 2 is index 1
                  loserId: game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId,
                  lastClickedTile: game.lastClickedTile, // Save lastClickedTile
                  isTimedGame: game.isTimedGame, // Save isTimedGame
                  playerTimes: game.playerTimes, // Save playerTimes
                  lastMoveTime: game.lastMoveTime, // Save lastMoveTime
              }, { merge: true });
              console.log(`Game ${gameId} status set to 'completed' in Firestore.`);
          } catch (error) {
              console.error("Error setting game status to 'completed' on mine reveal:", error);
          }
          // Clear userGameMap for both players when game is over
          game.players.forEach(p => delete userGameMap[p.userId]); 
          emitLobbyPlayersList(); // Update lobby list
      }
      // Turn does NOT switch if a mine is revealed.
      // The turn will only switch after a non-mine tile is revealed.

    } else { // This block handles non-mine tiles
      const isBlankTile = tile.adjacentMines === 0;
      const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0;

      if (isBlankTile && noFlagsRevealedYet) {
        console.log(`[GAME RESTART TRIGGERED] Player ${player.name} (${player.userId}) hit a blank tile at ${x},${y} before any flags were revealed. Restarting game ${gameId}.`);

        // Reset game state properties within the existing game object
        game.board = generateBoard(); // Generate a brand new board
        game.scores = { 1: 0, 2: 0 }; // Reset scores
        game.bombsUsed = { 1: false, 2: false }; // Reset bomb usage
        game.turn = 1; // Reset turn to player 1
        game.gameOver = false; // Game is no longer over
        game.lastClickedTile = { 1: null, 2: null }; // Reset lastClickedTile on restart
        if (game.isTimedGame) { // NEW: Reset timers and lastMoveTime for timed games
            game.playerTimes = { 1: INITIAL_PLAYER_TIME, 2: INITIAL_PLAYER_TIME };
            game.lastMoveTime = Date.now();
        }

        // Ensure userGameMap is still set for both players if game restarts but isn't completed
        game.players.forEach(p => userGameMap[p.userId] = gameId); 
        emitLobbyPlayersList(); // Update lobby list to ensure players stay 'in game'

        try {
          const serializedBoard = JSON.stringify(game.board);
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for restart
              board: serializedBoard,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              turn: game.turn,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile, // Save lastClickedTile
              isTimedGame: game.isTimedGame, // Save isTimedGame
              playerTimes: game.playerTimes, // Save playerTimes
              lastMoveTime: game.lastMoveTime, // Save lastMoveTime
              status: 'active', // Game is active after restart
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          }, { merge: true });
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
                    lastClickedTile: game.lastClickedTile, // Include lastClickedTile
                    isTimedGame: game.isTimedGame, // Include isTimedGame
                    playerTimes: game.playerTimes, // Include playerTimes
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

    // NEW: Timer Logic - Update lastMoveTime after turn switch (if game not over)
    if (game.isTimedGame && !game.gameOver) {
        game.lastMoveTime = Date.now();
    }

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board);
        // NEW: Conditionally set status to 'completed' if gameOver is true, otherwise 'active'
        const newStatus = game.gameOver ? 'completed' : 'active';
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for update
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            isTimedGame: game.isTimedGame, // Save isTimedGame
            playerTimes: game.playerTimes, // Save playerTimes
            lastMoveTime: game.lastMoveTime, // Save lastMoveTime
            status: newStatus, // Use the newStatus
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (tile-click). Status: ${newStatus}`);
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
                lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
                isTimedGame: game.isTimedGame, // Include isTimedGame
                playerTimes: game.playerTimes, // Include playerTimes
            });
        } else {
             console.warn(`Player ${p.name} in game ${gameId} has no active socket. Cannot send board update.`);
        }
    });
  });

  // Use Bomb Event
  socket.on("use-bomb", async ({ gameId }) => { // Changed to async
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const player = game.players.find((p) => p.userId === userId);
    // NEW: Add turn check here
    if (!player || player.number !== game.turn || game.bombsUsed[player.number]) {
        if (player && player.number !== game.turn) {
            console.warn(`Player ${player.name} tried to use bomb out of turn. Current turn: ${game.turn}`);
            // Optionally, send an error message back to the client
            io.to(socket.id).emit("bomb-error", "It's not your turn to use the bomb.");
        }
        return;
    }

    player.socketId = socket.id; // Update socket ID on action

    // NEW: Timer Logic - Check time before processing move for bomb usage
    if (game.isTimedGame) {
        const timeElapsedSinceLastMove = Date.now() - game.lastMoveTime; // In milliseconds
        let deduction = (timeElapsedSinceLastMove / 1000) - TIME_PER_MOVE; // In seconds
        
        if (deduction > 0) { // If time taken exceeds bonus time
            game.playerTimes[player.number] -= deduction;
            console.log(`[Timer] Player ${player.number} took ${timeElapsedSinceLastMove / 1000}s for bomb usage. Deducted ${deduction.toFixed(2)}s. Remaining time: ${game.playerTimes[player.number].toFixed(2)}s`);
        }

        if (game.playerTimes[player.number] <= 0) {
            game.playerTimes[player.number] = 0; // Ensure time doesn't go negative on display
            game.gameOver = true;
            const winnerPlayerNumber = player.number === 1 ? 2 : 1;
            const loserPlayerNumber = player.number;
            
            console.log(`[Timer] Player ${loserPlayerNumber} ran out of time (bomb usage) in game ${gameId}. Player ${winnerPlayerNumber} wins!`);
            
            game.players.forEach(p => {
                if (p.socketId) {
                    io.to(p.socketId).emit("time-out", { winnerPlayerNumber, loserPlayerNumber });
                }
            });

            // Update Firestore for game over due to time out
            try {
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    status: 'completed',
                    gameOver: true,
                    lastUpdated: Timestamp.now(),
                    winnerId: game.players.find(p => p.number === winnerPlayerNumber).userId,
                    loserId: game.players.find(p => p.number === loserPlayerNumber).userId,
                    lastClickedTile: game.lastClickedTile,
                    isTimedGame: game.isTimedGame,
                    playerTimes: game.playerTimes,
                    lastMoveTime: game.lastMoveTime, // Save final lastMoveTime
                }, { merge: true });
                console.log(`Game ${gameId} status set to 'completed' (time-out bomb) in Firestore.`);
            } catch (error) {
                console.error("Error setting game status to 'completed' (time-out bomb) in Firestore:", error);
            }
            game.players.forEach(p => delete userGameMap[p.userId]);
            emitLobbyPlayersList();
            return; // Exit as game is over
        }
    }

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
    // NEW: Add turn check here
    if (!player || player.number !== game.turn || game.bombsUsed[player.number]) {
        if (player && player.number !== game.turn) {
            console.warn(`Player ${player.name} tried to place bomb out of turn. Current turn: ${game.turn}`);
            // This might happen if 'wait-bomb-center' was emitted, but turn changed before selection.
            io.to(socket.id).emit("bomb-error", "It's not your turn to place the bomb.");
        }
        return;
    }

    player.socketId = socket.id; // Update socket ID on action

    // NEW: Timer Logic - Check time before processing bomb center
    if (game.isTimedGame) {
        const timeElapsedSinceLastMove = Date.now() - game.lastMoveTime; // In milliseconds
        let deduction = (timeElapsedSinceLastMove / 1000) - TIME_PER_MOVE; // In seconds
        
        if (deduction > 0) { // If time taken exceeds bonus time
            game.playerTimes[player.number] -= deduction;
            console.log(`[Timer] Player ${player.number} took ${timeElapsedSinceLastMove / 1000}s for bomb center. Deducted ${deduction.toFixed(2)}s. Remaining time: ${game.playerTimes[player.number].toFixed(2)}s`);
        }

        if (game.playerTimes[player.number] <= 0) {
            game.playerTimes[player.number] = 0; // Ensure time doesn't go negative on display
            game.gameOver = true;
            const winnerPlayerNumber = player.number === 1 ? 2 : 1;
            const loserPlayerNumber = player.number;
            
            console.log(`[Timer] Player ${loserPlayerNumber} ran out of time (bomb center) in game ${gameId}. Player ${winnerPlayerNumber} wins!`);
            
            game.players.forEach(p => {
                if (p.socketId) {
                    io.to(p.socketId).emit("time-out", { winnerPlayerNumber, loserPlayerNumber });
                }
            });

            // Update Firestore for game over due to time out
            try {
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                    status: 'completed',
                    gameOver: true,
                    lastUpdated: Timestamp.now(),
                    winnerId: game.players.find(p => p.number === winnerPlayerNumber).userId,
                    loserId: game.players.find(p => p.number === loserPlayerNumber).userId,
                    lastClickedTile: game.lastClickedTile,
                    isTimedGame: game.isTimedGame,
                    playerTimes: game.playerTimes,
                    lastMoveTime: game.lastMoveTime, // Save final lastMoveTime
                }, { merge: true });
                console.log(`Game ${gameId} status set to 'completed' (time-out bomb center) in Firestore.`);
            } catch (error) {
                console.error("Error setting game status to 'completed' (time-out bomb center) in Firestore:", error);
            }
            game.players.forEach(p => delete userGameMap[p.userId]);
            emitLobbyPlayersList();
            return; // Exit as game is over
        }
    }


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

    // Update last clicked tile for the current player using bomb center
    game.lastClickedTile = { ...game.lastClickedTile, [player.number]: { x, y } };


    game.bombsUsed[player.number] = true;
    revealArea(game.board, x, y, player.number, game.scores);

    if (checkGameOver(game.scores)) {
        game.gameOver = true;
        // NEW: Set game status to 'completed' in Firestore and clear userGameMap
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'completed', // Game is completed
                gameOver: true,
                lastUpdated: Timestamp.now(),
                winnerId: game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId, // Assuming player 1 is index 0, player 2 is index 1
                loserId: game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId,
                lastClickedTile: game.lastClickedTile, // Save lastClickedTile
                isTimedGame: game.isTimedGame, // Save isTimedGame
                playerTimes: game.playerTimes, // Save playerTimes
                lastMoveTime: game.lastMoveTime, // Save lastMoveTime
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'completed' in Firestore.`);
        } catch (error) {
            console.error("Error setting game status to 'completed' on bomb usage:", error);
        }
        // Clear userGameMap for both players when game is over
        game.players.forEach(p => delete userGameMap[p.userId]); 
        emitLobbyPlayersList(); // Update lobby list
    }
    else game.turn = game.turn === 1 ? 2 : 1;

    console.log(`Player ${player.name} used bomb at ${x},${y}. New scores: P1: ${game.scores[1]}, P2: ${game.scores[2]}`);

    // NEW: Timer Logic - Update lastMoveTime after turn switch (if game not over)
    if (game.isTimedGame && !game.gameOver) {
        game.lastMoveTime = Date.now();
    }

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        // NEW: Conditionally set status to 'completed' if gameOver is true, otherwise 'active'
        const newStatus = game.gameOver ? 'completed' : 'active';
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for update
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            isTimedGame: game.isTimedGame, // Save isTimedGame
            playerTimes: game.playerTimes, // Save playerTimes
            lastMoveTime: game.lastMoveTime, // Save lastMoveTime
            status: newStatus, // Use the newStatus
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? player.userId : game.players.find(p => p.userId !== userId).userId) : null
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (bomb-center). Status: ${newStatus}`);
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
                lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
                isTimedGame: game.isTimedGame, // Include isTimedGame
                playerTimes: game.playerTimes, // Include playerTimes
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
    game.lastClickedTile = { 1: null, 2: null }; // Reset lastClickedTile on restart
    if (game.isTimedGame) { // NEW: Reset timers and lastMoveTime for timed games
        game.playerTimes = { 1: INITIAL_PLAYER_TIME, 2: INITIAL_PLAYER_TIME };
        game.lastMoveTime = Date.now();
    }

    // Ensure userGameMap entries are still there for both players since the game is restarting, not ending
    game.players.forEach(p => userGameMap[p.userId] = gameId); 
    emitLobbyPlayersList(); // Update lobby list

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for restart
            board: serializedBoard,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            isTimedGame: game.isTimedGame, // Save isTimedGame
            playerTimes: game.playerTimes, // Save playerTimes
            lastMoveTime: game.lastMoveTime, // Save lastMoveTime
            status: 'active', // Game is active after restart
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null
        }, { merge: true });
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
                board: JSON.stringify(game.board),
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                lastClickedTile: game.lastClickedTile, // Include lastClickedTile
                isTimedGame: game.isTimedGame, // Include isTimedGame
                playerTimes: game.playerTimes, // Include playerTimes
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
    const playerInGame = game.players.find(p => p.userId === userId);
    if (playerInGame) {
      // Remove from userGameMap for the leaving user only
      delete userGameMap[userId];
      console.log(`User ${userId} (${playerInGame.name}) left game ${gameId}.`);

      // Set the leaving player's socketId in the in-memory game to null,
      // but do NOT remove them from game.players array completely.
      // This preserves their slot for potential future resumption (by themselves or if game ends and needs historical data).
      playerInGame.socketId = null;

      // Notify the opponent if one exists and is still connected
      const opponentPlayer = game.players.find(p => p.userId !== userId);
      if (opponentPlayer && opponentPlayer.socketId) {
          io.to(opponentPlayer.socketId).emit("opponent-left");
          console.log(`Notified opponent ${opponentPlayer.name} that their partner left.`);
      }

      // Always set game status in Firestore to 'waiting_for_resume' when a player voluntarily leaves.
      // The game should only be 'completed' by explicit game over conditions (win/loss).
      try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            status: 'waiting_for_resume',
            lastUpdated: Timestamp.now(),
            // Ensure timer state is saved when leaving for timed games
            isTimedGame: game.isTimedGame,
            playerTimes: game.playerTimes,
            lastMoveTime: game.lastMoveTime, // Keep lastMoveTime as is when leaving
        }, { merge: true });
        console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to player leaving.`);
      } catch (error) {
        console.error("Error updating game status to 'waiting_for_resume' on leave:", error);
      }
    } else {
        console.warn(`User ${userId} tried to leave game ${gameId} but not found in game.players.`);
        // If user wasn't found in game.players but userGameMap pointed to it, clear it.
        if (userGameMap[userId] === gameId) {
            delete userGameMap[userId];
            console.log(`Cleared stale userGameMap entry for ${userId} to game ${gameId}.`);
        }
    }
  } else {
      console.warn(`Attempt to leave game failed: game ${gameId} not found or userId missing.`);
  }

  // Attempt to re-add player to lobby list if they were logged in (all players now)
  // This logic should ensure the player is added to the lobby if they aren't already there
  // and are not currently active in another game (userGameMap[userId] would be null now).
  if (userId && !userGameMap[userId]) { // Only add to lobby if they successfully left their game and are not mapped to another
      let existingPlayerInLobby = players.find(p => p.userId === userId);
      if (existingPlayerInLobby) {
          existingPlayerInLobby.id = socket.id; // Update their socket if needed
          console.log(`User ${userName} updated in lobby players list with new socket.`);
      } else {
          const userNameForLobby = user ? user.displayName : `User_${userId.substring(0, 8)}`;
          players.push({ id: socket.id, userId: userId, name: userNameForLobby });
          console.log(`User ${userName} added to lobby players list.`);
      }
  }
  // Always update lobby list to reflect changes
  emitLobbyPlayersList(); // Use the helper
});



// Socket Disconnect Event (e.g., browser tab closed, network drop)
socket.on("disconnect", async () => { // Marked as async here
  console.log(`[Disconnect] Socket disconnected: ${socket.id}`);
  const user = socket.request.session?.passport?.user || null;
  const disconnectedUserId = user ? user.id : null;
  console.log(`[Disconnect] Disconnected user ID: ${disconnectedUserId}.`);

  if (disconnectedUserId) {
    // Correctly remove from userSocketMap as this specific socket is no longer active for this user
    // This is important because the user might reconnect with a new socket ID
    delete userSocketMap[disconnectedUserId];
    console.log(`[Disconnect] User ${disconnectedUserId} socket removed from userSocketMap.`);
  }

  // Filter players list: Remove from lobby if not in a game, or if their socket specifically disconnected.
  // CRITICAL: A player who was in a game should NOT be removed from 'players' if they're meant to resume.
  // The 'players' list should represent all online *users*, regardless of game status.
  // This line needs careful review based on your 'players' data structure.
  // If 'players' only stores lobby players, this is fine. If it stores ALL online users,
  // then a user who was in a game should remain, just marked as 'in-game' or 'disconnected-in-game'.
  // For now, assuming 'players' means "players currently in lobby or generally online".
  // The previous filter logic: `!(p.id === socket.id || (disconnectedUserId && p.userId === disconnectedUserId && !userGameMap[disconnectedUserId]))`
  // This logic removes a player if their socket ID matches OR if their userId matches AND they are NOT in a game.
  // This is okay if 'players' represents lobby + available-for-game players.
  // If 'players' should contain ALL online users for inviting purposes, then this filter should be adjusted
  // to only remove truly offline users.
  players = players.filter(p => !(p.id === socket.id && p.userId === disconnectedUserId) && userSocketMap[p.userId] !== undefined); // Only remove if socket matches and they are truly offline (no new socket)
  console.log(`[Disconnect] Players array after filter for disconnected socket: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);
  emitLobbyPlayersList(); // Use the helper


  // Check if the disconnected user was in a game
  if (disconnectedUserId && userGameMap[disconnectedUserId]) {
    const gameId = userGameMap[disconnectedUserId];
    const game = games[gameId];
    console.log(`[Disconnect] Disconnected user ${disconnectedUserId} was in game ${gameId}.`);

    if (game) {
      // Find and update the disconnected player's socketId within the in-memory game object
      const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
      if (disconnectedPlayerInGame) {
        disconnectedPlayerInGame.socketId = null; // Mark their socket as null
        console.log(`[Disconnect] Player ${disconnectedPlayerInGame.name} (${disconnectedUserId}) in game ${gameId} disconnected (socket marked null).`);
      }

      // Check if all players in this game are now disconnected (i.e., both have null socketIds)
      const allPlayersDisconnected = game.players.every(p => p.socketId === null);
      console.log(`[Disconnect] All players in game ${gameId} disconnected: ${allPlayersDisconnected}`);

      // The key change: The userGameMap should *not* be deleted here.
      // It must persist so the user can resume the game.
      // The game status in Firestore should reflect it's waiting for resume.
      try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
          status: 'waiting_for_resume', // Set game status to waiting_for_resume
          lastUpdated: Timestamp.now(),
          // Ensure timer state is saved for timed games when a player disconnects
          isTimedGame: game.isTimedGame,
          playerTimes: game.playerTimes,
          lastMoveTime: game.lastMoveTime, // Keep lastMoveTime as is when disconnecting
        }, { merge: true });
        console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
      } catch (error) {
        console.error("[Disconnect] Error updating game status to 'waiting_for_resume' on disconnect:", error);
      }

      // Notify the opponent if one exists and is still connected
      const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
      if (remainingPlayer && remainingPlayer.socketId) {
        io.to(remainingPlayer.socketId).emit("opponent-left"); // Inform the opponent
        console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
      }
      
      // Do NOT clear userGameMap entries for game participants here.
      // The userGameMap should maintain the user-to-game association for resumption.
      
    } else {
      // If game wasn't in memory but userGameMap pointed to it, it might be a stale entry. Clear it.
      delete userGameMap[disconnectedUserId];
      console.log(`[Disconnect] User ${disconnectedUserId} was mapped to game ${gameId} but game not in memory. Clearing userGameMap.`);
    }
  }
});

});

// --- Server Startup ---
const PORT = process.env.PORT || 3001; // Use Render's PORT env var, or 3001 for local dev
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
