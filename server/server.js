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
// It is then instantiated with 'new', and does NOT take 'session' directly in the require call.
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
app.use(express.json()); // Enable parsing of JSON body for guest login
// IMPORTANT: Add this line to trust proxy headers when deployed to Render
app.set('trust proxy', 1); 
const server = http.createServer(app);

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID, Guest ID)
// userGameMap maps userId to an object { gameId: string, role: 'player' | 'observer' }
const userGameMap = {};   // Maps userId to the gameId and role they are currently in

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
      
      // NEW: Redirect the pop-up window itself back to the frontend with data via postMessage
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
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
      
      // NEW: Redirect the pop-up window itself back to the frontend with data via postMessage
      const userData = {
        id: req.user.id,
        displayName: req.user.displayName
      };
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
        return res.status(400).json({ message: "Guest ID and name are required." });
    }

    // Set user data directly in the session for guest
    req.session.passport = { user: { id: guestId, displayName: `Guest_${guestId.substring(0, 8)}` }}; 

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
// Active games: gameId: { gameType: '1v1' | '2v2', team1Players: [{userId, name, playerNumber, socketId}], team2Players: [{userId, name, playerNumber, socketId}], board, scores: {1: int, 2: int}, bombsUsed: {1: bool, 2: bool}, turn: int (1-4), gameOver, lastClickedTile: {1: {}, 2: {}, 3: {}, 4: {}}, messages: [], observers: [{userId, name, socketId}], pendingInvitees: [{userId, status: 'pending' | 'accepted'}] }
let games = {};   

// --- Chat State ---
const lobbyMessages = []; // Stores messages for the lobby chat
const MAX_LOBBY_MESSAGES = 100; // Limit lobby chat history


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
            tile.owner = playerNumber; // Assign bomb owner (this will be the individual player number)
            
            // Increment score for the TEAM that owns this player
            const teamNumber = (playerNumber === 1 || playerNumber === 2) ? 1 : 2;
            scores[teamNumber]++; 
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
  // Game over if either team reaches 26 flags (mines)
  return scores[1] >= 26 || scores[2] >= 26;
};

// Helper to determine the next player's turn in a 2v2 game
const getNextTurnPlayerNumber = (currentGame, currentPlayerNumber, mineHit) => {
    if (mineHit) { // If a mine was hit, turn does not change
        return currentPlayerNumber;
    }

    const { gameType, team1Players, team2Players } = currentGame;

    if (gameType === '1v1') {
        return currentPlayerNumber === 1 ? 2 : 1;
    } else if (gameType === '2v2') {
        // Players are 1 (Team 1), 2 (Team 1), 3 (Team 2), 4 (Team 2)
        // Turn order: P1 -> P3 -> P2 -> P4 -> P1 ...
        switch (currentPlayerNumber) {
            case 1: return 3;
            case 2: return 4;
            case 3: return 2;
            case 4: return 1;
            default: return 1; // Should not happen
        }
    }
    return 1; // Default for 1v1
};

// Helper to emit the filtered list of players in the lobby
const emitLobbyPlayersList = () => {
    console.log(`[emitLobbyPlayersList] Full 'players' array before filtering: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);
    console.log(`[emitLobbyPlayersList] Current 'userGameMap': ${JSON.stringify(userGameMap)}`);

    // Modify to send all connected players with their game status
    const playersWithStatus = players.map(p => {
        const gameMapping = userGameMap[p.userId];
        let opponentName = null;
        let partnerName = null;
        let teamNumber = null;
        let gameType = null;

        if (gameMapping && gameMapping.role === 'player' && games[gameMapping.gameId]) {
            const game = games[gameMapping.gameId];
            gameType = game.gameType;
            if (game.gameType === '1v1') {
                opponentName = game.players.find(player => player.userId !== p.userId)?.name;
            } else if (game.gameType === '2v2') {
                // Determine which team the player is on
                const isTeam1 = game.team1Players.some(player => player.userId === p.userId);
                const isTeam2 = game.team2Players.some(player => player.userId === p.userId);

                if (isTeam1) {
                    teamNumber = 1;
                    partnerName = game.team1Players.find(player => player.userId !== p.userId)?.name;
                } else if (isTeam2) {
                    teamNumber = 2;
                    partnerName = game.team2Players.find(player => player.userId !== p.userId)?.name;
                }
            }
        }
        return {
            id: p.id,
            name: p.name,
            userId: p.userId, // Include userId for client-side filtering if needed
            gameId: gameMapping ? gameMapping.gameId : null,
            role: gameMapping ? gameMapping.role : null,
            gameType: gameType,
            opponentName: opponentName, // Only for 1v1
            partnerName: partnerName,   // Only for 2v2
            teamNumber: teamNumber      // Only for 2v2
        };
    });
    io.emit("players-list", playersWithStatus); // Send all players with their status
    console.log(`[emitLobbyPlayersList] Emitted players-list to lobby. Total online users: ${playersWithStatus.length}. Visible users: ${JSON.stringify(playersWithStatus.map(p => p.name))}`);
};

/**
 * Emits a list of observable games to all connected clients.
 * An observable game is one that is not over and has at least one connected player.
 */
const emitObservableGamesList = async () => {
    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('gameOver', '==', false) // Only fetch games that are NOT over
            .where('status', 'in', ['active', 'waiting_for_resume']) // Fetch active or waiting games
            .get();

        const observableGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            // A game is observable if the current user is NOT a player in it,
            // and it has at least one player currently connected (in-memory game `players` list contains a socketId)
            // or at least one observer connected.
            const gameInMem = games[gameData.gameId];
            let hasActiveParticipants = false;

            if (gameInMem) {
                // Check if any player has an active socket (for both 1v1 and 2v2)
                const activePlayers = gameInMem.players.filter(p => p.socketId).length;
                // Check if any observer has an active socket
                const anyObserverActive = gameInMem.observers.some(o => o.socketId);

                hasActiveParticipants = activePlayers > 0 || anyObserverActive;
            } else {
                // If game not in memory, we assume no active participants for observability
                // To observe, the game should be actively managed in memory with connected sockets.
            }

            if (hasActiveParticipants) {
                let displayPlayers = {};
                if (gameData.gameType === '1v1') {
                    displayPlayers.player1Name = gameData.player1_name;
                    displayPlayers.player2Name = gameData.player2_name;
                } else if (gameData.gameType === '2v2') {
                    displayPlayers.player1Name = gameData.team1Players[0].name;
                    displayPlayers.player2Name = gameData.team1Players[1].name;
                    displayPlayers.player3Name = gameData.team2Players[0].name;
                    displayPlayers.player4Name = gameData.team2Players[1].name;
                }
                
                observableGames.push({
                    gameId: gameData.gameId,
                    gameType: gameData.gameType,
                    ...displayPlayers,
                    scores: gameData.scores,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                    activeParticipants: (gameInMem ? (gameInMem.players.filter(p => p.socketId).length + gameInMem.observers.filter(o => o.socketId).length) : 0)
                });
            }
        });

        io.emit("receive-observable-games", observableGames);
        console.log(`[emitObservableGamesList] Emitted ${observableGames.length} observable games.`);
    } catch (error) {
        console.error("Error fetching and emitting observable games list:", error);
    }
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
        const gameMapping = userGameMap[userId];
        const gameId = gameMapping.gameId;
        const role = gameMapping.role; // 'player' or 'observer'
        let game = games[gameId]; // Try to get from in-memory first

        if (!game) { // If not in memory, try to load from Firestore
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                    const gameData = doc.data();
                    const deserializedBoard = JSON.parse(gameData.board);

                    // Reconstruct in-memory game object based on gameType
                    game = {
                        gameId: gameData.gameId,
                        gameType: gameData.gameType,
                        board: deserializedBoard,
                        scores: gameData.scores,
                        bombsUsed: gameData.bombsUsed,
                        turn: gameData.turn,
                        gameOver: gameData.gameOver,
                        lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null, 3: null, 4: null }, // Load lastClickedTile
                        messages: gameData.messages || [], // Load game chat messages
                        observers: (gameData.observers || []).filter(obs => // Filter out players from observers list loaded from Firestore
                            gameData.gameType === '1v1' ? (obs.userId !== gameData.player1_userId && obs.userId !== gameData.player2_userId) :
                            (obs.userId !== gameData.team1Players[0].userId && obs.userId !== gameData.team1Players[1].userId &&
                             obs.userId !== gameData.team2Players[0].userId && obs.userId !== gameData.team2Players[1].userId)
                        )
                    };

                    if (gameData.gameType === '1v1') {
                        game.players = [];
                        let player1 = players.find(p => p.userId === gameData.player1_userId);
                        if (!player1) { player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 }; players.push(player1); }
                        player1.socketId = userSocketMap[player1.userId] || null;

                        let player2 = players.find(p => p.userId === gameData.player2_userId);
                        if (!player2) { player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 }; players.push(player2); }
                        player2.socketId = userSocketMap[player2.userId] || null;
                        game.players = [player1, player2];
                    } else if (gameData.gameType === '2v2') {
                        game.players = []; // Will contain all 4 players
                        game.team1Players = [];
                        game.team2Players = [];

                        gameData.team1Players.forEach(pData => {
                            let player = players.find(p => p.userId === pData.userId);
                            if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
                            player.socketId = userSocketMap[player.userId] || null;
                            game.team1Players.push(player);
                            game.players.push(player);
                        });
                        gameData.team2Players.forEach(pData => {
                            let player = players.find(p => p.userId === pData.userId);
                            if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
                            player.socketId = userSocketMap[player.userId] || null;
                            game.team2Players.push(player);
                            game.players.push(player);
                        });
                    }

                    // Update observers' socketIds
                    game.observers.forEach(observer => {
                        observer.socketId = userSocketMap[observer.userId] || null;
                    });

                    games[gameId] = game; // Add game to in-memory active games

                    // Set game status to active if it was waiting for resume
                    if (gameData.status === 'waiting_for_resume') {
                        doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).then(() => {
                            console.log(`Game ${gameId} status updated to 'active' in Firestore on resume.`);
                        }).catch(e => console.error("Error updating game status on resume:", e));
                    }

                    // --- Handle Player Reconnection ---
                    if (role === 'player') {
                        const playerInGame = game.players.find(p => p.userId === userId);
                        
                        if (playerInGame && playerInGame.socketId) {
                            socket.join(gameId); // Join game room on resume
                            
                            // Determine opponent name for 1v1 or team names for 2v2
                            let opponentName = "Opponent";
                            if (game.gameType === '1v1') {
                                opponentName = game.players.find(op => op.userId !== userId)?.name;
                            } else if (game.gameType === '2v2') {
                                // For 2v2, the 'opponentName' on client could be the partner's name for simplicity
                                const myTeam = (playerInGame.playerNumber === 1 || playerInGame.playerNumber === 2) ? game.team1Players : game.team2Players;
                                opponentName = myTeam.find(p => p.userId !== userId)?.name; // Display partner
                            }

                            io.to(playerInGame.socketId).emit("game-start", { // Using game-start for initial state after resume
                                gameId: game.gameId,
                                playerNumber: playerInGame.playerNumber,
                                gameType: game.gameType,
                                board: JSON.stringify(game.board),
                                turn: game.turn,
                                scores: game.scores,
                                bombsUsed: game.bombsUsed,
                                gameOver: game.gameOver,
                                lastClickedTile: game.lastClickedTile, // Include lastClickedTile
                                opponentName: opponentName, // Opponent or partner for UI display
                                gameChat: game.messages, // Send game chat history
                                observers: game.observers // Send observer list
                            });
                            console.log(`Emitted game-start to reconnected player ${playerInGame.name} for game ${gameId}.`);
                            io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' }); // Notify others in game

                            // Notify remaining players in the game (both partners and opponents)
                            game.players.forEach(p => {
                                if (p.userId !== userId && p.socketId) {
                                    io.to(p.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                                    console.log(`Notified player ${p.name} of ${playerInGame.name} re-connection in game ${gameId}.`);
                                }
                            });
                        }
                    } 
                    // --- Handle Observer Reconnection ---
                    else if (role === 'observer') {
                        const observerInGame = game.observers.find(o => o.userId === userId);
                        if (!observerInGame) { // Add if not found in the loaded list (shouldn't happen if Firestore is clean)
                            game.observers.push({ userId, name: userName, socketId: socket.id });
                            // Update Firestore. Ensure unique observers.
                            doc.ref.update({ observers: FieldValue.arrayUnion({ userId, name: userName }) }); 
                        } else {
                            observerInGame.socketId = socket.id; // Update existing observer's socketId
                        }
                        socket.join(gameId); // Join game room
                        io.to(socket.id).emit("game-start", {
                            gameId: game.gameId,
                            playerNumber: 0, // Indicate observer role
                            gameType: game.gameType,
                            board: JSON.stringify(game.board),
                            turn: game.turn,
                            scores: game.scores,
                            bombsUsed: game.bombsUsed,
                            gameOver: game.gameOver,
                            lastClickedTile: game.lastClickedTile,
                            opponentName: "N/A", // No opponent for observer
                            gameChat: game.messages,
                            observers: game.observers // Send current observer list
                        });
                        console.log(`Emitted game-start to reconnected observer ${userName} for game ${gameId}.`);
                        io.to(gameId).emit("observer-joined", { name: userName, userId: userId }); // Notify others in game
                    }
                    emitLobbyPlayersList(); // Update lobby list
                    emitObservableGamesList(); // Update observable games list
                } else {
                    delete userGameMap[userId]; // Game not found or invalid status, clear map
                    console.log(`Game ${gameId} for user ${userId} not found or invalid status in Firestore. Clearing userGameMap.`);
                    emitLobbyPlayersList(); // Re-emit if userGameMap changed
                    emitObservableGamesList(); // Update observable games list
                }
            }).catch(e => console.error("Error fetching game from Firestore on reconnect:", e));
        } else { // Game found in memory
            // Update player/observer socketId in in-memory game object
            if (role === 'player') {
                const playerInGame = game.players.find(p => p.userId === userId);
                if (playerInGame) {
                    playerInGame.socketId = socket.id;
                    socket.join(gameId);

                    let opponentName = "Opponent";
                    if (game.gameType === '1v1') {
                        opponentName = game.players.find(op => op.userId !== userId)?.name;
                    } else if (game.gameType === '2v2') {
                        const myTeam = (playerInGame.playerNumber === 1 || playerInGame.playerNumber === 2) ? game.team1Players : game.team2Players;
                        opponentName = myTeam.find(p => p.userId !== userId)?.name;
                    }

                    io.to(playerInGame.socketId).emit("game-start", {
                        gameId: game.gameId,
                        playerNumber: playerInGame.playerNumber,
                        gameType: game.gameType,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: opponentName,
                        gameChat: game.messages,
                        observers: game.observers
                    });
                    console.log(`Re-sent active game state for game ${gameId} to player ${playerInGame.name}.`);
                    io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' }); // Notify other observers

                    game.players.forEach(p => {
                        if (p.userId !== userId && p.socketId) {
                            io.to(p.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                            console.log(`Notified player ${p.name} of ${playerInGame.name} re-connection in game ${gameId}.`);
                        }
                    });
                }
            } else if (role === 'observer') {
                const observerInGame = game.observers.find(o => o.userId === userId);
                if (observerInGame) {
                    observerInGame.socketId = socket.id;
                    socket.join(gameId);
                    io.to(socket.id).emit("game-start", {
                        gameId: game.gameId,
                        playerNumber: 0, // Indicate observer role
                        gameType: game.gameType,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: "N/A", // No opponent for observer
                        gameChat: game.messages,
                        observers: game.observers
                    });
                    console.log(`Re-sent active game state for game ${gameId} to observer ${userName}.`);
                    io.to(gameId).emit("observer-joined", { name: userName, userId: userId }); // Notify others in game
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

    socket.join("lobby"); // IMPORTANT: Join the lobby room
    console.log(`Player ${userName} (${userId}) joined lobby with socket ID ${socket.id}. Total lobby players: ${players.length}`);
    socket.emit("lobby-joined", userName); // Send back the name used
    socket.emit("initial-lobby-messages", lobbyMessages); // Send lobby chat history to new joiner

    // Emit updated player list to all connected clients in the lobby (all players now)
    console.log(`[Join Lobby] Calling emitLobbyPlayersList. Current userGameMap: ${JSON.stringify(userGameMap)}`);
    emitLobbyPlayersList(); // Use the helper
    emitObservableGamesList(); // Request observable games when joining lobby
  });

  // Handle Lobby Chat Messages
  socket.on("send-lobby-message", (message) => {
    const user = socket.request.session?.passport?.user || null;
    const userName = user ? user.displayName : 'Anonymous'; // Fallback for sender name
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = { sender: userName, text: message, timestamp: timestamp };
    lobbyMessages.push(fullMessage);
    if (lobbyMessages.length > MAX_LOBBY_MESSAGES) {
      lobbyMessages.shift(); // Remove oldest message if over limit
    }
    io.to("lobby").emit("receive-lobby-message", fullMessage); // Emit to the "lobby" room
    console.log(`Lobby message from ${userName}: ${message}`);
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
            const isPlayerIn1v1 = gameData.gameType === '1v1' && (gameData.player1_userId === userId || gameData.player2_userId === userId);
            const isPlayerIn2v2 = gameData.gameType === '2v2' && (
                gameData.team1Players.some(p => p.userId === userId) ||
                gameData.team2Players.some(p => p.userId === userId)
            );

            if (isPlayerIn1v1 || isPlayerIn2v2) {
                // Determine opponent name for 1v1 or relevant team info for 2v2
                let opponentName = null;
                let myPlayerNumber = null;

                if (gameData.gameType === '1v1') {
                    myPlayerNumber = gameData.player1_userId === userId ? 1 : 2;
                    opponentName = myPlayerNumber === 1 ? gameData.player2_name : gameData.player1_name;
                } else if (gameData.gameType === '2v2') {
                    // For 2v2 unfinished games, we might just show team names or indicate it's a 2v2 game
                    // No direct "opponentName" as it's a team game
                }


                unfinishedGames.push({
                    gameId: gameData.gameId,
                    board: gameData.board, // Send serialized board for potential client-side preview
                    opponentName: opponentName, // Only for 1v1
                    myPlayerNumber: myPlayerNumber, // Only for 1v1
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                    scores: gameData.scores, // Team scores for both
                    gameType: gameData.gameType,
                    // Add player names for 2v2 for display
                    player1Name: gameData.gameType === '2v2' ? gameData.team1Players[0].name : gameData.player1_name,
                    player2Name: gameData.gameType === '2v2' ? gameData.team1Players[1].name : gameData.player2_name,
                    player3Name: gameData.gameType === '2v2' ? gameData.team2Players[0].name : undefined,
                    player4Name: gameData.gameType === '2v2' ? gameData.team2Players[1].name : undefined,
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
      if (userGameMap[userId] && userGameMap[userId].gameId === gameId) {
          delete userGameMap[userId];
      }
      return;
    }

    const gameData = gameDoc.data();

    // Verify that the resuming user is one of the players in this game
    const isPlayerIn1v1 = gameData.gameType === '1v1' && (gameData.player1_userId === userId || gameData.player2_userId === userId);
    const isPlayerIn2v2 = gameData.gameType === '2v2' && (
        gameData.team1Players.some(p => p.userId === userId) ||
        gameData.team2Players.some(p => p.userId === userId)
    );

    if (!isPlayerIn1v1 && !isPlayerIn2v2) {
      socket.emit("join-error", "You are not a participant in this game.");
      return;
    }

    let currentPlayerNumber;
    let opponentDisplayName = "Opponent"; // For 1v1 or partner's name for 2v2 UI
    let teamNumber = null; // For 2v2

    if (gameData.gameType === '1v1') {
        currentPlayerNumber = gameData.player1_userId === userId ? 1 : 2;
        opponentDisplayName = currentPlayerNumber === 1 ? gameData.player2_name : gameData.player1_name;
    } else if (gameData.gameType === '2v2') {
        const allPlayers = [...gameData.team1Players, ...gameData.team2Players];
        const me = allPlayers.find(p => p.userId === userId);
        if (me) {
            currentPlayerNumber = me.playerNumber;
            teamNumber = me.team;
            // For 2v2, opponentName in client can be used to display partner's name
            const myTeamPlayers = teamNumber === 1 ? gameData.team1Players : gameData.team2Players;
            opponentDisplayName = myTeamPlayers.find(p => p.userId !== userId)?.name;
        }
    }


    // Check if the game is already in memory
    if (games[gameId]) {
      const existingGame = games[gameId];

      // Update all players' socket IDs in the in-memory game based on the global userSocketMap.
      existingGame.players.forEach(player => {
          player.socketId = userSocketMap[player.userId] || null;
      });
      // Also update observer socket IDs
      existingGame.observers.forEach(observer => {
          observer.socketId = userSocketMap[observer.userId] || null;
      });

      const currentPlayerInGame = existingGame.players.find(p => p.userId === userId);
      
      if (!currentPlayerInGame) {
          socket.emit("join-error", "Internal error: You are a participant but not found in in-memory game players.");
          console.error(`Error: User ${userId} is a game participant but not in existingGame.players array.`);
          return;
      }

      if (currentPlayerInGame.socketId === socket.id) {
          socket.join(gameId); // IMPORTANT: Join the game room for the resuming player
          // Update userGameMap for the player's role
          userGameMap[userId] = { gameId, role: 'player' };

          // Emit the game state to the resuming player
          io.to(currentPlayerInGame.socketId).emit("game-start", { // Using game-start for initial state after resume
              gameId: existingGame.gameId,
              playerNumber: currentPlayerNumber, // Use the derived number
              gameType: existingGame.gameType,
              board: JSON.stringify(existingGame.board),
              turn: existingGame.turn,
              scores: existingGame.scores,
              bombsUsed: existingGame.bombsUsed,
              gameOver: existingGame.gameOver,
              lastClickedTile: existingGame.lastClickedTile, // Include lastClickedTile
              opponentName: opponentDisplayName, // Use the derived name
              gameChat: existingGame.messages, // Send game chat history
              observers: existingGame.observers // Send observer list
          });
          console.log(`User ${userName} (re)connected to game ${gameId} from in-memory state.`);

          // Notify other players in the game (both partners and opponents)
          existingGame.players.forEach(p => {
              if (p.userId !== userId && p.socketId) {
                  io.to(p.socketId).emit("opponent-reconnected", { name: userName }); // This message is generic "opponent" but covers partners/opponents
                  console.log(`Notified player ${p.name} of ${userName} re-connection in game ${gameId}.`);
              }
          });
          io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' }); // Notify all (including observers)
          emitLobbyPlayersList();
          emitObservableGamesList();
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
      gameType: gameData.gameType,
      board: deserializedBoard,
      scores: gameData.scores,
      bombsUsed: gameData.bombsUsed,
      turn: gameData.turn,
      gameOver: gameData.gameOver,
      lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null, 3: null, 4: null }, // Load lastClickedTile from Firestore
      messages: gameData.messages || [], // Load game chat messages
      observers: (gameData.observers || []).filter(obs => // Filter out players from observers list loaded from Firestore
          gameData.gameType === '1v1' ? (obs.userId !== gameData.player1_userId && obs.userId !== gameData.player2_userId) :
          (obs.userId !== gameData.team1Players[0].userId && obs.userId !== gameData.team1Players[1].userId &&
           obs.userId !== gameData.team2Players[0].userId && obs.userId !== gameData.team2Players[1].userId)
      )
    };

    if (gameData.gameType === '1v1') {
        game.players = [];
        let player1 = players.find(p => p.userId === gameData.player1_userId);
        if (!player1) { player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 }; players.push(player1); }
        player1.socketId = (gameData.player1_userId === userId) ? socket.id : (userSocketMap[gameData.player1_userId] || null);

        let player2 = players.find(p => p.userId === gameData.player2_userId);
        if (!player2) { player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 }; players.push(player2); }
        player2.socketId = (gameData.player2_userId === userId) ? socket.id : (userSocketMap[gameData.player2_userId] || null);
        game.players = [player1, player2];
    } else if (gameData.gameType === '2v2') {
        game.players = []; // All 4 players in one flat array for easier lookup
        game.team1Players = [];
        game.team2Players = [];

        gameData.team1Players.forEach(pData => {
            let player = players.find(p => p.userId === pData.userId);
            if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
            player.socketId = (pData.userId === userId) ? socket.id : (userSocketMap[pData.userId] || null);
            game.team1Players.push(player);
            game.players.push(player);
        });
        gameData.team2Players.forEach(pData => {
            let player = players.find(p => p.userId === pData.userId);
            if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
            player.socketId = (pData.userId === userId) ? socket.id : (userSocketMap[pData.userId] || null);
            game.team2Players.push(player);
            game.players.push(player);
        });
    }

    // Update observers' socketIds
    game.observers.forEach(observer => {
        observer.socketId = userSocketMap[observer.userId] || null;
    });

    games[gameId] = game; // Add game to in-memory active games
    
    // Ensure userGameMap is correctly set for all players to this gameId and role
    if (gameData.gameType === '1v1') {
        userGameMap[gameData.player1_userId] = { gameId, role: 'player' }; 
        userGameMap[gameData.player2_userId] = { gameId, role: 'player' };
    } else if (gameData.gameType === '2v2') {
        gameData.team1Players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });
        gameData.team2Players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });
    }

    // Update Firestore status from 'waiting_for_resume' to 'active'
    if (gameData.status === 'waiting_for_resume') {
      await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
      console.log(`Game ${gameId} status updated to 'active' in Firestore.`);
    }

    // Emit game-start to the player who resumed
    const currentPlayerInGame = game.players.find(p => p.userId === userId);

    if (currentPlayerInGame && currentPlayerInGame.socketId) {
      socket.join(gameId); // IMPORTANT: Join the game room for the resuming player
      io.to(currentPlayerInGame.socketId).emit("game-start", { // Using game-start for initial state after resume
        gameId: game.gameId,
        playerNumber: currentPlayerInGame.playerNumber,
        gameType: game.gameType,
        board: JSON.stringify(game.board), // Send serialized board
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile
        opponentName: opponentDisplayName, // Include opponent name for 1v1, or partner name for 2v2
        gameChat: game.messages, // Send game chat history
        observers: game.observers // Send observer list
      });
      console.log(`User ${userName} successfully resumed game ${gameId}.`);
      io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' }); // Notify others
    }

    // Notify other players (both partners and opponents) in the game if they are connected
    game.players.forEach(p => {
        if (p.userId !== userId && p.socketId) {
            io.to(p.socketId).emit("opponent-reconnected", { name: userName });
            console.log(`Notified player ${p.name} that ${userName} reconnected to game ${gameId}.`);
        }
    });

    // Update lobby player list (all players now)
    emitLobbyPlayersList(); // Use the helper
    emitObservableGamesList(); // Update observable games list

  } catch (error) {
    console.error("Error resuming game:", error);
    socket.emit("join-error", "Failed to resume game. " + error.message);
    // If an error occurs, ensure userGameMap is cleaned up if it was set incorrectly
    if (userGameMap[userId] && userGameMap[userId].gameId === gameId) {
        delete userGameMap[userId];
    }
  }
});

  // NEW: Observe Game Event
  socket.on("observe-game", async ({ gameId }) => {
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : 'Anonymous Observer';

    if (!userId) {
        socket.emit("join-error", "Authentication required to observe game.");
        return;
    }

    // If already in a game (as player or observer), prevent observing another
    if (userGameMap[userId]) {
        socket.emit("join-error", "You are already in a game or observing another.");
        console.warn(`Observer ${userName} (${userId}) tried to observe game ${gameId} but already mapped to ${userGameMap[userId].gameId}.`);
        return;
    }

    userSocketMap[userId] = socket.id; // Update socket map

    try {
        const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
        const gameDoc = await gameDocRef.get();

        if (!gameDoc.exists) {
            socket.emit("join-error", "Game not found or already ended.");
            return;
        }

        const gameData = gameDoc.data();
        if (gameData.gameOver) {
            socket.emit("join-error", "Game is already over and cannot be observed.");
            return;
        }
        // Prevent observing a game you are playing in
        const isPlayerIn1v1 = gameData.gameType === '1v1' && (gameData.player1_userId === userId || gameData.player2_userId === userId);
        const isPlayerIn2v2 = gameData.gameType === '2v2' && (
            gameData.team1Players.some(p => p.userId === userId) ||
            gameData.team2Players.some(p => p.userId === userId)
        );
        if (isPlayerIn1v1 || isPlayerIn2v2) {
            socket.emit("join-error", "You are a player in this game, not an observer.");
            return;
        }

        let game = games[gameId];
        if (!game) {
            // Load game into memory if not already there
            const deserializedBoard = JSON.parse(gameData.board);
            game = {
                gameId: gameData.gameId,
                gameType: gameData.gameType,
                board: deserializedBoard,
                scores: gameData.scores,
                bombsUsed: gameData.bombsUsed,
                turn: gameData.turn,
                gameOver: gameData.gameOver,
                lastClickedTile: gameData.lastClickedTile || { 1: null, 2: null, 3: null, 4: null },
                messages: gameData.messages || []
            };

            if (gameData.gameType === '1v1') {
                game.players = [];
                let player1 = players.find(p => p.userId === gameData.player1_userId);
                if (!player1) player1 = { userId: gameData.player1_userId, name: gameData.player1_name, number: 1 };
                player1.socketId = userSocketMap[player1.userId] || null;

                let player2 = players.find(p => p.userId === gameData.player2_userId);
                if (!player2) player2 = { userId: gameData.player2_userId, name: gameData.player2_name, number: 2 };
                player2.socketId = userSocketMap[player2.userId] || null;
                game.players = [player1, player2];
            } else if (gameData.gameType === '2v2') {
                game.players = [];
                game.team1Players = [];
                game.team2Players = [];

                gameData.team1Players.forEach(pData => {
                    let player = players.find(p => p.userId === pData.userId);
                    if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
                    player.socketId = userSocketMap[player.userId] || null;
                    game.team1Players.push(player);
                    game.players.push(player);
                });
                gameData.team2Players.forEach(pData => {
                    let player = players.find(p => p.userId === pData.userId);
                    if (!player) { player = { userId: pData.userId, name: pData.name, number: pData.playerNumber, team: pData.team }; players.push(player); }
                    player.socketId = userSocketMap[player.userId] || null;
                    game.team2Players.push(player);
                    game.players.push(player);
                });
            }
            
            // Filter out players from observers list loaded from Firestore
            game.observers = (gameData.observers || []).filter(obs => 
                gameData.gameType === '1v1' ? (obs.userId !== gameData.player1_userId && obs.userId !== gameData.player2_userId) :
                (obs.userId !== gameData.team1Players[0].userId && obs.userId !== gameData.team1Players[1].userId &&
                 obs.userId !== gameData.team2Players[0].userId && obs.userId !== gameData.team2Players[1].userId)
            );
            // Update observers' socketIds
            game.observers.forEach(observer => {
                observer.socketId = userSocketMap[observer.userId] || null;
            });
            
            games[gameId] = game; // Add to in-memory games
        }

        // Add observer to the game's observer list in memory
        const newObserver = { userId, name: userName, socketId: socket.id };
        const existingObserverIndex = game.observers.findIndex(o => o.userId === userId);
        if (existingObserverIndex === -1) {
            game.observers.push(newObserver);
        } else {
            game.observers[existingObserverIndex].socketId = socket.id; // Update existing observer's socketId
        }
        
        // Update Firestore with the new observer (ensure it's just the userId and name)
        await gameDocRef.update({
            observers: FieldValue.arrayUnion({ userId, name: userName }) // Store minimal info in Firestore
        });
        console.log(`Observer ${userName} (${userId}) joined game ${gameId}.`);

        socket.join(gameId); // Join the game-specific Socket.IO room

        // Update userGameMap for the observer
        userGameMap[userId] = { gameId, role: 'observer' };

        // Emit game-start to the new observer
        io.to(socket.id).emit("game-start", {
            gameId: game.gameId,
            playerNumber: 0, // 0 indicates an observer
            gameType: game.gameType,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            opponentName: "N/A", // Observers don't have an "opponent"
            gameChat: game.messages,
            observers: game.observers // Send the list of current observers in this game
        });

        // Notify players and other observers in the game about the new observer
        io.to(gameId).emit("observer-joined", { name: userName, userId: userId });

        emitLobbyPlayersList(); // Update lobby list since an observer might be "in game" from lobby perspective
        emitObservableGamesList(); // Refresh observable games for client
    } catch (error) {
        console.error("Error observing game:", error);
        socket.emit("join-error", "Failed to observe game. " + error.message);
    }
  });


  socket.on("invite-player", (targetSocketId) => {
    const inviterUser = socket.request.session?.passport?.user || null;
    const inviterUserId = inviterUser ? inviterUser.id : null;
    
    const inviterPlayer = players.find((p) => p.userId === inviterUserId);
    const invitedPlayer = players.find((p) => p.id === targetSocketId); // targetSocketId is the socket.id from playersList on client

    if (!inviterPlayer || !invitedPlayer) {
      console.warn(`Invite failed: Inviter or invitee not found. Inviter: ${inviterPlayer?.name}, Invitee: ${invitedPlayer?.name}`);
      return;
    }
    // Check if either player is already associated with a game (as player or observer)
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

  // Respond to 1v1 Invite Event
  socket.on("respond-invite", async ({ fromId, accept }) => {
    const respondingUser = socket.request.session?.passport?.user || null;
    const respondingUserId = respondingUser ? respondingUser.id : null;

    const respondingPlayer = players.find((p) => p.userId === respondingUserId);
    const inviterPlayer = players.find((p) => p.id === fromId); // fromId is inviter's socket.id

    if (!respondingPlayer || !inviterPlayer) {
        console.warn("Respond invite failed: Players not found.");
        return;
    }

    // Double check if either player is already in a game (as player or observer)
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
      const lastClickedTile = { 1: null, 2: null, 3: null, 4: null }; // Initialize lastClickedTile for all 4 possible players for generic game structure

      const game = {
        gameId,
        gameType: '1v1', // Mark game type
        board: newBoard,
        players: [
          // Store userId and current socketId for players in the game object
          { userId: inviterPlayer.userId, name: inviterPlayer.name, playerNumber: 1, socketId: inviterPlayer.id },
          { userId: respondingPlayer.userId, name: respondingPlayer.name, playerNumber: 2, socketId: respondingPlayer.id },
        ],
        turn,
        scores,
        bombsUsed,
        gameOver,
        lastClickedTile, // Include lastClickedTile in in-memory game object
        messages: [], // Initialize game chat messages
        observers: [] // Initialize empty observers array for a new game
      };
      games[gameId] = game;

      // Update userGameMap for both players as players
      userGameMap[inviterPlayer.userId] = { gameId, role: 'player' };
      userGameMap[respondingPlayer.userId] = { gameId, role: 'player' };
      console.log(`Game ${gameId} (1v1) started between ${inviterPlayer.name} (${inviterPlayer.userId}) and ${respondingPlayer.name} (${respondingPlayer.userId}).`);

      // Add both players to the game-specific Socket.IO room
      io.sockets.sockets.get(inviterPlayer.id)?.join(gameId);
      io.sockets.sockets.get(respondingPlayer.id)?.join(gameId);

      // Save game state to Firestore (with serialized board)
      try {
          const serializedBoard = JSON.stringify(game.board); // Serialize board for Firestore
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              gameId: game.gameId,
              gameType: game.gameType,
              board: serializedBoard, // Save serialized board
              player1_userId: inviterPlayer.userId,
              player2_userId: respondingPlayer.userId,
              player1_name: inviterPlayer.name,
              player2_name: respondingPlayer.name,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile, // Save lastClickedTile to Firestore
              status: 'active', // Mark as active
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null,
              messages: game.messages, // Save initial empty message array to Firestore
              observers: game.observers // Save empty observers array to Firestore
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
          emitObservableGamesList(); // Update observable games list on failure
          return;
      }

      // Remove players from the general lobby list as they are now in a game
      emitLobbyPlayersList(); // Use the helper
      emitObservableGamesList(); // Update observable games list as a new game started

      // Emit game-start to both players with their specific player number and opponent name
      io.to(inviterPlayer.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 1,
        gameType: game.gameType,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        opponentName: respondingPlayer.name,
        gameChat: game.messages, // Send game chat history
        observers: game.observers // Send observer list
      });
      io.to(respondingPlayer.id).emit("game-start", {
        gameId: game.gameId,
        playerNumber: 2,
        gameType: game.gameType,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        opponentName: inviterPlayer.name,
        gameChat: game.messages, // Send game chat history
        observers: game.observers // Send observer list
      });

    } else {
      io.to(fromId).emit("invite-rejected", { fromName: respondingPlayer.name });
      console.log(`Invite from ${inviterPlayer.name} rejected by ${respondingPlayer.name}.`);
      emitLobbyPlayersList(); // Re-emit if invite rejected, to ensure lobby list is accurate
      emitObservableGamesList(); // Refresh observable games
    }
  });

  // NEW: Send 2v2 Invite Event
  socket.on("send-2v2-invite", async (data) => {
    const { inviterUserId, inviterName, partnerUserId, partnerName, opponent1UserId, opponent1Name, opponent2UserId, opponent2Name, inviteeSocketIds } = data;

    // Basic validation
    const requiredUsers = [inviterUserId, partnerUserId, opponent1UserId, opponent2UserId];
    const uniqueUsers = new Set(requiredUsers);
    if (uniqueUsers.size !== 4) {
        io.to(socket.id).emit("join-error", "Invalid 2v2 invite: All four players must be unique.");
        return;
    }

    // Check if any of the players are already in a game
    for (const userId of requiredUsers) {
        if (userGameMap[userId]) {
            io.to(socket.id).emit("join-error", `${players.find(p => p.userId === userId)?.name || userId} is already in a game.`);
            return;
        }
    }

    const gameId = uuidv4();
    const newBoard = generateBoard();
    const scores = { 1: 0, 2: 0 }; // Team 1, Team 2
    const bombsUsed = { 1: false, 2: false }; // Team 1, Team 2
    const turn = 1; // Always start with player 1 of Team 1
    const gameOver = false;
    const lastClickedTile = { 1: null, 2: null, 3: null, 4: null }; // Track last clicked tile for each of 4 players

    // Define player numbers and teams
    const team1Players = [
        { userId: inviterUserId, name: inviterName, playerNumber: 1, team: 1, socketId: userSocketMap[inviterUserId] },
        { userId: partnerUserId, name: partnerName, playerNumber: 2, team: 1, socketId: userSocketMap[partnerUserId] },
    ];
    const team2Players = [
        { userId: opponent1UserId, name: opponent1Name, playerNumber: 3, team: 2, socketId: userSocketMap[opponent1UserId] },
        { userId: opponent2UserId, name: opponent2Name, playerNumber: 4, team: 2, socketId: userSocketMap[opponent2UserId] },
    ];

    const game = {
        gameId,
        gameType: '2v2',
        board: newBoard,
        team1Players, // Array of player objects for team 1
        team2Players, // Array of player objects for team 2
        players: [...team1Players, ...team2Players], // Combined for easy iteration
        turn,
        scores,
        bombsUsed,
        gameOver,
        lastClickedTile,
        messages: [],
        observers: [],
        // NEW: Track pending invitees for 2v2 game setup
        pendingInvitees: [
            { userId: inviterUserId, status: 'accepted' }, // Inviter auto-accepts
            { userId: partnerUserId, status: 'pending' },
            { userId: opponent1UserId, status: 'pending' },
            { userId: opponent2UserId, status: 'pending' },
        ]
    };
    games[gameId] = game;

    // Assign game to inviter immediately
    userGameMap[inviterUserId] = { gameId, role: 'player' };

    // Save initial game state to Firestore with pending invitations
    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId: game.gameId,
            gameType: game.gameType,
            board: serializedBoard,
            team1Players: team1Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })), // Store without socketId
            team2Players: team2Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })), // Store without socketId
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            status: 'pending_2v2_invite', // New status for 2v2 setup
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null,
            messages: game.messages,
            observers: game.observers,
            pendingInvitees: game.pendingInvitees // Store pending invitees for persistence
        });
        console.log(`2v2 Game ${gameId} created in Firestore with pending status.`);
    } catch (error) {
        console.error("Error saving new 2v2 game to Firestore:", error);
        io.to(socket.id).emit("join-error", "Failed to start 2v2 game (DB error).");
        delete games[gameId];
        delete userGameMap[inviterUserId];
        emitLobbyPlayersList();
        emitObservableGamesList();
        return;
    }

    // Emit invites to other players
    inviteeSocketIds.forEach(targetSocketId => {
        const invitedPlayer = players.find(p => p.id === targetSocketId);
        if (invitedPlayer) {
            let yourTeamNumber = null;
            let partnerOfInvitee = null;
            if (team1Players.some(p => p.userId === invitedPlayer.userId)) {
                yourTeamNumber = 1;
                partnerOfInvitee = team1Players.find(p => p.userId !== invitedPlayer.userId);
            } else if (team2Players.some(p => p.userId === invitedPlayer.userId)) {
                yourTeamNumber = 2;
                partnerOfInvitee = team2Players.find(p => p.userId !== invitedPlayer.userId);
            }

            io.to(targetSocketId).emit("2v2-game-invite", {
                gameId: game.gameId,
                inviterName: inviterName,
                partnerName: partnerOfInvitee.name,
                opponent1Name: team1Players.find(p => p.userId !== inviterUserId)?.name, // This will be inviter's partner
                opponent2Name: team2Players[0].name,
                opponent3Name: team2Players[1].name,
                yourTeamNumber: yourTeamNumber
            });
            console.log(`2v2 invite sent to ${invitedPlayer.name} (Team ${yourTeamNumber}).`);
        }
    });

    emitLobbyPlayersList(); // Update lobby list
    emitObservableGamesList(); // Update observable games list
  });


  // NEW: Respond to 2v2 Invite Event
  socket.on("respond-2v2-invite", async ({ gameId, accept, myTeamNumber }) => {
    const respondingUser = socket.request.session?.passport?.user || null;
    const respondingUserId = respondingUser ? respondingUser.id : null;
    const respondingUserName = respondingUser ? respondingUser.displayName : 'Unknown';

    if (!respondingUserId) {
        io.to(socket.id).emit("join-error", "Authentication required to respond to invite.");
        return;
    }

    let game = games[gameId];
    if (!game) {
        // Try to load from Firestore if not in memory (e.g., server restart)
        const gameDoc = await db.collection(GAMES_COLLECTION_PATH).doc(gameId).get();
        if (!gameDoc.exists || gameDoc.data().status !== 'pending_2v2_invite') {
            io.to(socket.id).emit("invite-rejected", { fromName: "Game System", reason: "Game invite expired or not found." });
            return;
        }
        game = gameDoc.data();
        // Reconstruct in-memory game object if loaded from Firestore for pending invite.
        // This is a minimal reconstruction for handling invite logic.
        game.players = [...game.team1Players, ...game.team2Players];
        game.players.forEach(p => p.socketId = userSocketMap[p.userId] || null); // Update socketIds
        game.observers = (game.observers || []).map(o => ({ ...o, socketId: userSocketMap[o.userId] || null }));
        games[gameId] = game; // Add to in-memory
    }

    const inviteeEntry = game.pendingInvitees.find(inv => inv.userId === respondingUserId);

    if (!inviteeEntry || inviteeEntry.status !== 'pending') {
        io.to(socket.id).emit("invite-rejected", { fromName: "Game System", reason: "You are not a pending invitee for this game." });
        return;
    }

    if (accept) {
        inviteeEntry.status = 'accepted';
        // Add the player to userGameMap
        userGameMap[respondingUserId] = { gameId, role: 'player' };
        // Add current socket to the game's in-memory player object
        const playerInGame = game.players.find(p => p.userId === respondingUserId);
        if (playerInGame) {
            playerInGame.socketId = socket.id;
        }
        socket.join(gameId); // Join the game room

        console.log(`User ${respondingUserName} (${respondingUserId}) accepted 2v2 invite for game ${gameId}.`);
    } else {
        inviteeEntry.status = 'rejected';
        console.log(`User ${respondingUserName} (${respondingUserId}) rejected 2v2 invite for game ${gameId}.`);
        // Notify all other pending players that the invite was rejected
        game.pendingInvitees.filter(inv => inv.userId !== respondingUserId && inv.status === 'pending').forEach(inv => {
            const playerSocketId = userSocketMap[inv.userId];
            if (playerSocketId) {
                io.to(playerSocketId).emit("invite-rejected", { fromName: respondingUserName, reason: "One player rejected the 2v2 invite." });
            }
        });
        // Clear game related info for all players if someone rejects
        // This makes the game invalid and cleanup should happen.
        delete games[gameId];
        game.players.forEach(p => delete userGameMap[p.userId]); // Clear all player mappings
        emitLobbyPlayersList(); // Update lobby for everyone
        emitObservableGamesList(); // Update observable list
        
        // Remove game from Firestore if rejected by anyone
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).delete();
        console.log(`2v2 Game ${gameId} deleted from Firestore due to rejection.`);
        return; // Exit as game is dissolved
    }

    // Update Firestore with the new acceptance status
    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            pendingInvitees: game.pendingInvitees,
            lastUpdated: Timestamp.now()
        });
    } catch (error) {
        console.error("Error updating 2v2 invite status in Firestore:", error);
    }


    // Check if all players have accepted
    const allAccepted = game.pendingInvitees.every(inv => inv.status === 'accepted');

    if (allAccepted) {
        game.status = 'active'; // Set game to active
        // Update Firestore status
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                status: 'active',
                lastUpdated: Timestamp.now()
            });
            console.log(`2v2 Game ${gameId} status set to 'active' in Firestore.`);
        } catch (error) {
            console.error("Error setting 2v2 game status to 'active' in Firestore:", error);
        }

        console.log(`All players accepted for 2v2 game ${gameId}. Starting game.`);

        // Emit game-start to all players
        game.players.forEach(p => {
            if (p.socketId) {
                let opponentDisplayName;
                // For 2v2, the 'opponentName' on client could be the partner's name
                const myTeam = (p.playerNumber === 1 || p.playerNumber === 2) ? game.team1Players : game.team2Players;
                opponentDisplayName = myTeam.find(partner => partner.userId !== p.userId)?.name;

                io.to(p.socketId).emit("game-start", {
                    gameId: game.gameId,
                    playerNumber: p.playerNumber,
                    gameType: game.gameType,
                    board: JSON.stringify(game.board),
                    turn: game.turn,
                    scores: game.scores,
                    bombsUsed: game.bombsUsed,
                    gameOver: game.gameOver,
                    lastClickedTile: game.lastClickedTile,
                    opponentName: opponentDisplayName, // Send partner's name for client UI
                    gameChat: game.messages,
                    observers: game.observers
                });
            }
        });
        emitLobbyPlayersList(); // Update lobby list for all players
        emitObservableGamesList(); // Update observable games list
    } else {
        console.log(`Waiting for other players to accept 2v2 invite for game ${gameId}.`);
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
    // Crucial check: only players can click tiles, not observers
    if (!player || player.playerNumber !== game.turn) { // Use player.playerNumber for turn check
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

    // Update last clicked tile for the current player
    game.lastClickedTile = { ...game.lastClickedTile, [player.playerNumber]: { x, y } };

    let mineHit = false;
    // --- Start of Re-ordered and Corrected Logic ---
    if (tile.isMine) {
      mineHit = true;
      tile.revealed = true;
      tile.owner = player.playerNumber; // Assign owner to the mine (individual player number)
      
      const teamNumber = (player.playerNumber === 1 || player.playerNumber === 2) ? 1 : 2;
      game.scores[teamNumber]++; // Increment score for the TEAM

      console.log(`[Tile Click] Player ${player.name} revealed a mine at (${x},${y}). New score for Team ${teamNumber}: ${game.scores[teamNumber]}`);

      if (checkGameOver(game.scores)) {
          game.gameOver = true;
          // Set winner/loser based on team scores
          const winnerTeam = game.scores[1] > game.scores[2] ? 1 : 2;
          const winnerIds = winnerTeam === 1 ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId);
          const loserIds = winnerTeam === 1 ? game.team2Players.map(p => p.userId) : game.team1Players.map(p => p.userId);

          try {
              await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                  status: 'completed', // Game is completed
                  gameOver: true,
                  lastUpdated: Timestamp.now(),
                  winnerId: winnerIds[0], // Store first winner ID for simplicity, or an array
                  winnerIds: winnerIds, // Store all winner IDs
                  loserId: loserIds[0], // Store first loser ID for simplicity, or an array
                  loserIds: loserIds, // Store all loser IDs
                  lastClickedTile: game.lastClickedTile, // Save lastClickedTile
              }, { merge: true });
              console.log(`Game ${gameId} status set to 'completed' in Firestore.`);
          } catch (error) {
              console.error("Error setting game status to 'completed' on mine reveal:", error);
          }
          // Clear userGameMap for all players when game is over
          game.players.forEach(p => delete userGameMap[p.userId]); 
          // Do NOT clear observers from userGameMap here. They should remain observers until they leave.
          emitLobbyPlayersList(); // Update lobby list
          emitObservableGamesList(); // Update observable games list on game completion
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
        game.lastClickedTile = { 1: null, 2: null, 3: null, 4: null }; // Reset lastClickedTile on restart
        game.messages = []; // Clear game chat messages on restart

        // Ensure userGameMap is still set for all players if game restarts but isn't completed
        game.players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' }); 
        // Observers remain observers
        game.observers.forEach(o => userGameMap[o.userId] = { gameId, role: 'observer' });
        emitLobbyPlayersList(); // Update lobby list to ensure players stay 'in game'
        emitObservableGamesList(); // Update observable games list on game restart

        try {
          const serializedBoard = JSON.stringify(game.board);
          // For 2v2, include all player details
          const playersToSave = game.gameType === '1v1' ? 
            { player1_userId: game.players[0].userId, player2_userId: game.players[1].userId, player1_name: game.players[0].name, player2_name: game.players[1].name } :
            { team1Players: game.team1Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })),
              team2Players: game.team2Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })) };

          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for restart
              board: serializedBoard,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              turn: game.turn,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile, // Save lastClickedTile
              status: 'active', // Game is active after restart
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null,
              messages: game.messages, // Save cleared messages
              observers: game.observers.map(o => ({ userId: o.userId, name: o.name })), // Save observers list
              gameType: game.gameType,
              ...playersToSave
          }, { merge: true });
          console.log(`Game ${gameId} restarted and updated in Firestore.`);
        } catch (error) {
            console.error("Error restarting game in Firestore:", error);
        }

        // Emit to all players AND observers in the game room
        io.to(gameId).emit("game-restarted", {
            gameId: game.gameId,
            playerNumber: player.playerNumber, // This will be the player's own number, not observer's 0
            gameType: game.gameType,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name || "Opponent" : game.players.find(p => p.userId === player.userId)?.name, // For 2v2, could be partner's name or not applicable
            gameChat: game.messages,
            observers: game.observers // Send observer list
        });
        console.log(`[GAME RESTARTED] Game ${gameId} state after reset. Players: ${game.players.map(p => p.name).join(', ')}. Observers: ${game.observers.map(o => o.name).join(', ')}`);
        return; // Important: Exit after restarting
      }

      // If not a mine and not a restart condition on a blank tile, then it's a normal reveal
      revealRecursive(game.board, x, y);
      // Determine next turn based on game type
      game.turn = getNextTurnPlayerNumber(game, player.playerNumber, mineHit);
    }
    // --- End of Re-ordered and Corrected Logic ---

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board);
        // NEW: Conditionally set status to 'completed' if gameOver is true, otherwise 'active'
        const newStatus = game.gameOver ? 'completed' : 'active';
        
        // Prepare player data for Firestore based on game type
        const playersToSave = game.gameType === '1v1' ? 
            { player1_userId: game.players[0].userId, player2_userId: game.players[1].userId, player1_name: game.players[0].name, player2_name: game.players[1].name } :
            { team1Players: game.team1Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })),
              team2Players: game.team2Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })) };

        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for update
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            status: newStatus, // Use the newStatus
            lastUpdated: Timestamp.now(),
            gameType: game.gameType,
            ...playersToSave, // Add players data
            winnerId: game.gameOver ? (game.gameType === '1v1' ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : (game.scores[1] > game.scores[2] ? game.team1Players[0].userId : game.team2Players[0].userId)) : null,
            loserId: game.gameOver ? (game.gameType === '1v1' ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : (game.scores[1] < game.scores[2] ? game.team1Players[0].userId : game.team2Players[0].userId)) : null,
            winnerIds: game.gameOver ? (game.scores[1] > game.scores[2] ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId)) : FieldValue.delete(), // Delete if not 2v2 or game not over
            loserIds: game.gameOver ? (game.scores[1] < game.scores[2] ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId)) : FieldValue.delete(), // Delete if not 2v2 or game not over
            observers: game.observers.map(o => ({ userId: o.userId, name: o.name })) // Save observers list
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (tile-click). Status: ${newStatus}`);
        if (game.gameOver) {
          emitObservableGamesList(); // Update observable games list on game completion
        }
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error);
    }

    // Emit board-update to all players AND observers in the game room
    io.to(gameId).emit("board-update", {
        gameId: game.gameId,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        observers: game.observers // Send observer list
    });
  });

  // Handle Game Chat Messages
  socket.on("send-game-message", async ({ gameId, message }) => {
    const game = games[gameId];
    if (!game) {
      console.warn(`Attempted to send message to non-existent game ${gameId}`);
      return;
    }
    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const userName = user ? user.displayName : 'Anonymous';
    
    if (!userId) {
        console.warn(`Unauthenticated user tried to send game message to ${gameId}`);
        return;
    }

    // Only allow players or active observers to send messages
    const isPlayer = game.players.some(p => p.userId === userId);
    const isObserver = game.observers.some(o => o.userId === userId);

    if (!isPlayer && !isObserver) {
        console.warn(`User ${userName} (${userId}) is not a player or observer in game ${gameId}, cannot send message.`);
        return;
    }


    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = { sender: userName, text: message, timestamp: timestamp };
    game.messages.push(fullMessage);
    // Optionally limit game chat history (e.g., to 100 messages)
    // if (game.messages.length > MAX_GAME_MESSAGES) {
    //   game.messages.shift();
    // }
    io.to(gameId).emit("receive-game-message", fullMessage); // Emit to everyone in the game room
    console.log(`Game ${gameId} message from ${userName}: ${message}`);

    // Persist messages to Firestore (append to existing messages array)
    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            messages: FieldValue.arrayUnion(fullMessage)
        });
        console.log(`Game ${gameId} chat message saved to Firestore.`);
    } catch (error) {
        console.error("Error saving game message to Firestore:", error);
    }
  });

  // Use Bomb Event
  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || null;
    const userId = user ? user.id : null;
    const player = game.players.find((p) => p.userId === userId);
    
    // Determine team number for bomb usage
    const teamNumber = (player.playerNumber === 1 || player.playerNumber === 2) ? 1 : 2;

    if (!player || player.playerNumber !== game.turn || game.bombsUsed[teamNumber]) { // Check team's bomb usage
        if (player && player.playerNumber !== game.turn) {
            console.warn(`Player ${player.name} tried to use bomb out of turn. Current turn: ${game.turn}`);
            // Optionally, send an error message back to the client
            io.to(socket.id).emit("bomb-error", "It's not your turn to use the bomb.");
        } else if (game.bombsUsed[teamNumber]) {
            io.to(socket.id).emit("bomb-error", "Your team has already used its bomb!");
        }
        return;
    }

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
    
    const teamNumber = (player.playerNumber === 1 || player.playerNumber === 2) ? 1 : 2;

    if (!player || player.playerNumber !== game.turn || game.bombsUsed[teamNumber]) { // Check team's bomb usage
        if (player && player.playerNumber !== game.turn) {
            console.warn(`Player ${player.name} tried to place bomb out of turn. Current turn: ${game.turn}`);
            // This might happen if 'wait-bomb-center' was emitted, but turn changed before selection.
            io.to(socket.id).emit("bomb-error", "It's not your turn to place the bomb.");
        } else if (game.bombsUsed[teamNumber]) {
            io.to(socket.id).emit("bomb-error", "Your team has already used your bomb!");
        }
        return;
    }

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

    // Update last clicked tile for the current player using bomb center
    game.lastClickedTile = { ...game.lastClickedTile, [player.playerNumber]: { x, y } };


    game.bombsUsed[teamNumber] = true; // Mark team's bomb as used
    revealArea(game.board, x, y, player.playerNumber, game.scores); // Reveal and update team score

    if (checkGameOver(game.scores)) {
        game.gameOver = true;
        // Set winner/loser based on team scores
        const winnerTeam = game.scores[1] > game.scores[2] ? 1 : 2;
        const winnerIds = winnerTeam === 1 ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId);
        const loserIds = winnerTeam === 1 ? game.team2Players.map(p => p.userId) : game.team1Players.map(p => p.userId);

        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'completed', // Game is completed
                gameOver: true,
                lastUpdated: Timestamp.now(),
                winnerId: winnerIds[0], // Store first winner ID for simplicity, or an array
                winnerIds: winnerIds, // Store all winner IDs
                loserId: loserIds[0], // Store first loser ID for simplicity, or an array
                loserIds: loserIds, // Store all loser IDs
                lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            }, { merge: true });
            console.log(`Game ${gameId} status set to 'completed' in Firestore.`);
        } catch (error) {
            console.error("Error setting game status to 'completed' on bomb usage:", error);
        }
        // Clear userGameMap for all players when game is over
        game.players.forEach(p => delete userGameMap[p.userId]); 
        // Do NOT clear observers from userGameMap here. They should remain observers until they leave.
        emitLobbyPlayersList(); // Update lobby list
        emitObservableGamesList(); // Update observable games list on game completion
    }
    // Turn switches after bomb usage (unless game over)
    else game.turn = getNextTurnPlayerNumber(game, player.playerNumber, false);

    console.log(`Player ${player.name} (Team ${teamNumber}) used bomb at ${x},${y}. New scores: T1: ${game.scores[1]}, T2: ${game.scores[2]}`);

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        const newStatus = game.gameOver ? 'completed' : 'active';

        // Prepare player data for Firestore based on game type
        const playersToSave = game.gameType === '1v1' ? 
            { player1_userId: game.players[0].userId, player2_userId: game.players[1].userId, player1_name: game.players[0].name, player2_name: game.players[1].name } :
            { team1Players: game.team1Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })),
              team2Players: game.team2Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })) };

        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for update
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            status: newStatus, // Use the newStatus
            lastUpdated: Timestamp.now(),
            gameType: game.gameType,
            ...playersToSave, // Add players data
            winnerId: game.gameOver ? (game.gameType === '1v1' ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : (game.scores[1] > game.scores[2] ? game.team1Players[0].userId : game.team2Players[0].userId)) : null,
            loserId: game.gameOver ? (game.gameType === '1v1' ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : (game.scores[1] < game.scores[2] ? game.team1Players[0].userId : game.team2Players[0].userId)) : null,
            winnerIds: game.gameOver ? (game.scores[1] > game.scores[2] ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId)) : FieldValue.delete(), // Delete if not 2v2 or game not over
            loserIds: game.gameOver ? (game.scores[1] < game.scores[2] ? game.team1Players.map(p => p.userId) : game.team2Players.map(p => p.userId)) : FieldValue.delete(), // Delete if not 2v2 or game not over
            observers: game.observers.map(o => ({ userId: o.userId, name: o.name })) // Save observers list
        }, { merge: true });
        console.log(`Game ${gameId} updated in Firestore (bomb-center). Status: ${newStatus}`);
        if (game.gameOver) {
          emitObservableGamesList(); // Update observable games list on game completion
        }
    } catch (error) {
        console.error("Error updating game in Firestore (bomb-center):", error); // Log the full error object
    }


    // Emit board-update to all players AND observers in the game room
    io.to(gameId).emit("board-update", {
        gameId: game.gameId,
        board: JSON.stringify(game.board), // Send serialized board to client
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile, // Include lastClickedTile in emitted data
        observers: game.observers // Send observer list
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
    game.lastClickedTile = { 1: null, 2: null, 3: null, 4: null }; // Reset lastClickedTile on restart
    game.messages = []; // Clear game chat messages on restart

    // Ensure userGameMap entries are still there for all players since the game is restarting, not ending
    game.players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' }); 
    game.observers.forEach(o => userGameMap[o.userId] = { gameId, role: 'observer' }); // Observers remain observers
    emitLobbyPlayersList(); // Update lobby list
    emitObservableGamesList(); // Update observable games list on game restart

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board); // Serialize for Firestore
        // For 2v2, include all player details
        const playersToSave = game.gameType === '1v1' ? 
            { player1_userId: game.players[0].userId, player2_userId: game.players[1].userId, player1_name: game.players[0].name, player2_name: game.players[1].name } :
            { team1Players: game.team1Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })),
              team2Players: game.team2Players.map(p => ({ userId: p.userId, name: p.name, playerNumber: p.playerNumber, team: p.team })) };

        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({ // Use set with merge true for restart
            board: serializedBoard,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            status: 'active', // Game is active after restart
            lastUpdated: Timestamp.now(),
            winnerId: null,
            loserId: null,
            messages: game.messages, // Save cleared messages
            observers: game.observers.map(o => ({ userId: o.userId, name: o.name })), // Save observers list
            gameType: game.gameType,
            ...playersToSave
        }, { merge: true });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error); // Log the full error object
    }

    // Emit to all players AND observers in the game room
    io.to(gameId).emit("game-restarted", { // Use game-restarted event
        gameId: game.gameId,
        playerNumber: requestingPlayer.playerNumber, // This will be the player's own number, not observer's 0
        gameType: game.gameType,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name || "Opponent" : requestingPlayer.name, // For 2v2, can be partner's name or not applicable for UI
        gameChat: game.messages,
        observers: game.observers // Send observer list
    });
  });

 // Leave Game Event (Player or Observer voluntarily leaves)
socket.on("leave-game", async ({ gameId }) => {
  const game = games[gameId];
  const user = socket.request.session?.passport?.user || null;
  const userId = user ? user.id : null;
  const userName = user ? user.displayName : 'Unknown User';


  if (game && userId) {
    const gameMapping = userGameMap[userId];
    if (!gameMapping || gameMapping.gameId !== gameId) {
        console.warn(`User ${userId} tried to leave game ${gameId} but was not mapped to it.`);
        return;
    }

    // Remove from userGameMap
    delete userGameMap[userId];
    socket.leave(gameId); // Make the socket leave the game room

    if (gameMapping.role === 'player') {
      const playerInGame = game.players.find(p => p.userId === userId);
      if (playerInGame) {
        playerInGame.socketId = null; // Mark their socket as null
        console.log(`User ${userId} (${playerInGame.name}) left game ${gameId} as a player.`);

        // Notify other players in the game (both partners and opponents)
        game.players.forEach(p => {
            if (p.userId !== userId && p.socketId) {
                io.to(p.socketId).emit("opponent-left"); // Generic "opponent left" message
                console.log(`Notified player ${p.name} that ${playerInGame.name} left.`);
            }
        });
        // Notify observers in the game that a player left
        io.to(gameId).emit("player-left", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });

        // Set game status to 'waiting_for_resume' when a player voluntarily leaves.
        try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              status: 'waiting_for_resume',
              lastUpdated: Timestamp.now()
          }, { merge: true });
          console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore due to player leaving.`);
        } catch (error) {
          console.error("Error updating game status to 'waiting_for_resume' on player leave:", error);
        }
      }
    } else if (gameMapping.role === 'observer') {
      // Remove observer from the in-memory game object
      game.observers = game.observers.filter(o => o.userId !== userId);
      console.log(`User ${userId} (${userName}) left game ${gameId} as an observer.`);
      
      // Update Firestore to remove the observer
      try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
              observers: FieldValue.arrayRemove({ userId, name: userName })
          });
          console.log(`Observer ${userName} removed from game ${gameId} in Firestore.`);
      } catch (error) {
          console.error("Error removing observer from Firestore on leave:", error);
      }
      // Notify others in the game that an observer left
      io.to(gameId).emit("observer-left", { name: userName, userId: userId });
    }
  } else {
      console.warn(`Attempt to leave game failed: game ${gameId} not found or userId missing.`);
  }

  // Attempt to re-add player/observer to lobby list if they were logged in
  if (userId && !userGameMap[userId]) { // Only add to lobby if they successfully left their game and are not mapped to another
      let existingPlayerInLobby = players.find(p => p.userId === userId);
      if (existingPlayerInLobby) {
          existingPlayerInLobby.id = socket.id; // Update their socket if needed
          console.log(`User ${userName} updated in lobby players list with new socket.`);
      } else {
          // If the user was removed from players[] on disconnect (e.g. if they weren't in a game)
          // and now they leave a game, ensure they're back in `players` for lobby visibility
          const userNameForLobby = user ? user.displayName : `User_${userId.substring(0, 8)}`;
          players.push({ id: socket.id, userId: userId, name: userNameForLobby });
          console.log(`User ${userName} added to lobby players list after leaving game.`);
      }
  }
  emitLobbyPlayersList(); // Always update lobby list to reflect changes
  emitObservableGamesList(); // Refresh observable games
});


// Socket Disconnect Event (e.g., browser tab closed, network drop)
socket.on("disconnect", async () => {
  console.log(`[Disconnect] Socket disconnected: ${socket.id}`);
  const user = socket.request.session?.passport?.user || null;
  const disconnectedUserId = user ? user.id : null;
  const disconnectedUserName = user ? user.displayName : 'Unknown User';

  if (disconnectedUserId) {
    // Correctly remove from userSocketMap as this specific socket is no longer active for this user
    delete userSocketMap[disconnectedUserId];
    console.log(`[Disconnect] User ${disconnectedUserId} socket removed from userSocketMap.`);
  }

  // Filter players list: This list represents users who are currently online.
  // We only remove a user from this global list if there's no other active socket for their userId.
  players = players.filter(p => userSocketMap[p.userId] !== undefined); 
  console.log(`[Disconnect] Players array after filter for disconnected socket: ${JSON.stringify(players.map(p => ({ id: p.id, userId: p.userId, name: p.name })))}`);
  emitLobbyPlayersList(); // Use the helper to update lobby list


  // Check if the disconnected user was in a game (as player or observer)
  let gameId = null;
  let role = null;
  // Iterate through userGameMap to find if the disconnected user was in any game
  for (const uid in userGameMap) {
      if (uid === disconnectedUserId) {
          gameId = userGameMap[uid].gameId;
          role = userGameMap[uid].role;
          break;
      }
  }

  if (gameId) {
    const game = games[gameId];
    console.log(`[Disconnect] Disconnected user ${disconnectedUserId} was in game ${gameId} as a ${role}.`);

    if (game) {
      if (role === 'player') {
        const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
        if (disconnectedPlayerInGame) {
          disconnectedPlayerInGame.socketId = null; // Mark their socket as null
          console.log(`[Disconnect] Player ${disconnectedPlayerInGame.name} (${disconnectedUserId}) in game ${gameId} disconnected (socket marked null).`);
        }

        // The userGameMap entry for players should *not* be deleted here.
        // It must persist so the player can resume the game.
        // The game status in Firestore should reflect it's waiting for resume.
        try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            status: 'waiting_for_resume', // Set game status to waiting_for_resume
            lastUpdated: Timestamp.now()
          }, { merge: true });
          console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
        } catch (error) {
          console.error("[Disconnect] Error updating game status to 'waiting_for_resume' on disconnect:", error);
        }

        // Notify other players in the game (partners and opponents)
        game.players.forEach(p => {
            if (p.userId !== disconnectedUserId && p.socketId) {
                io.to(p.socketId).emit("opponent-left"); // Generic "opponent left" message
                console.log(`Notified player ${p.name} that ${disconnectedUserName} disconnected.`);
            }
        });
        // Notify observers in the game that a player disconnected
        io.to(gameId).emit("player-left", { name: disconnectedUserName, userId: disconnectedUserId, role: 'player' });

      } else if (role === 'observer') {
        // Remove observer's socketId from the in-memory game object
        const disconnectedObserverInGame = game.observers.find(o => o.userId === disconnectedUserId);
        if (disconnectedObserverInGame) {
            disconnectedObserverInGame.socketId = null;
            console.log(`[Disconnect] Observer ${disconnectedObserverInGame.name} (${disconnectedUserId}) disconnected (socket marked null).`);
        }
        // Do NOT remove observer from Firestore or game.observers list on disconnect,
        // just mark their socket as null. They will be removed on explicit 'leave-game' or if game ends.
        // Or, you could remove them from the in-memory `observers` array if you want to consider them fully gone
        // until they explicitly observe again, and remove from Firestore too.

        // Notify others in the game that an observer left (disconnected)
        io.to(gameId).emit("observer-left", { name: disconnectedUserName, userId: disconnectedUserId, role: 'observer' });
      }
      emitObservableGamesList(); // Refresh observable games
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
