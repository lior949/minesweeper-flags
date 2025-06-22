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
const userGameMap = {};   // Maps userId to the gameId they are currently in
const activeGameObservers = {}; // Stores Firestore unsubscribe functions keyed by gameId

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
  passport.authenticate('facebook', { failureRedirect: 'https://minesweeper-flags-frontend.onrender.com/login-failed' }),
  (req, res) => { // Add a callback to manually save session
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Facebook auth:", err);
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
let games = {};   // Active games: gameId: { players: [{userId, name, number, socketId}], observers: [{userId, name, socketId}], board, scores, bombsUsed, turn, gameOver, lastClickedTile }

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
    // Collect all connected sockets that have a userId and displayName (meaning they are logged in/guest)
    const playersInLobby = [];
    for (const [socketId, socket] of io.sockets.sockets.entries()) {
        // Only include players who are authenticated and not currently in a game
        if (socket.userId && socket.displayName && !userGameMap[socket.userId]) {
            playersInLobby.push({
                id: socket.id, // This is the socket's unique ID, used for direct targeting
                name: socket.displayName
            });
        }
    }

    console.log(`[emitLobbyPlayersList] Emitting 'players-list' with data: ${JSON.stringify(playersInLobby)}`);
    io.emit("players-list", playersInLobby);
    console.log(`[emitLobbyPlayersList] Emitted players-list to lobby. Total visible players: ${playersInLobby.length}.`);
};


// Function to count unrevealed mines
function countUnrevealedMines(board) {
    let count = 0;
    for (let y = 0; y < board.length; y++) {
        for (let x = 0; x < board[0].length; x++) {
            if (board[y][x].isMine && !board[y][x].revealed) {
                count++;
            }
        }
    }
    return count;
}


// NEW: Firestore Observer Setup
// Map to store unsubscribe functions for each game observer

// Function to set up a Firestore observer for a given gameId
const setupGameObserver = (gameId, ioInstance) => {
  if (activeGameObservers[gameId]) {
    console.log(`Observer for game ${gameId} already exists. Skipping setup.`);
    return;
  }

  const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);

  // Set up the real-time listener
  const unsubscribe = gameRef.onSnapshot(async (docSnapshot) => {
    if (!docSnapshot.exists) {
      console.log(`Game ${gameId} no longer exists in Firestore.`);
      // Clean up observer if game is deleted
      if (activeGameObservers[gameId]) {
        activeGameObservers[gameId](); // Call the unsubscribe function
        delete activeGameObservers[gameId];
        console.log(`Observer for game ${gameId} unsubscribed and removed.`);
      }
      // Inform all clients in the game room that the game is over/deleted
      ioInstance.to(gameId).emit("game-deleted");
      return;
    }

    const game = docSnapshot.data();
    console.log(`[Firestore Change] Game ${gameId} updated. Status: ${game.status}`);

    // Reconstruct board if stored as JSON string
    game.board = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;

    // Determine current player and opponent details dynamically
    const playersInGame = game.players || [];
    const player1 = playersInGame.find(p => p.playerNumber === 1);
    const player2 = playersInGame.find(p => p.playerNumber === 2);

    // Emit game state updates to all connected players and observers in this game room
    ioInstance.to(gameId).emit("game-state-update", {
      gameId: game.gameId,
      board: game.board,
      turn: game.turn,
      scores: game.scores || { 1: 0, 2: 0 },
      bombsUsed: game.bombsUsed || { 1: false, 2: false },
      gameOver: game.gameOver,
      waitingForBombCenter: game.waitingForBombCenter || false,
      lastClickedTile: game.lastClickedTile || { 1: null, 2: null },
      unrevealedMines: countUnrevealedMines(game.board),
      // NEW: Send player names for observer view
      player1Name: player1?.name,
      player2Name: player2?.name
    });

    // Handle game starting (player2 joins) - only send once
    if (game.status === 'active' && player1 && player2 && !game.startedEventSent) {
        console.log(`Game ${gameId} is now active with two players. Sending game-started event.`);
        // Emit to players that the game has started (specific details for each player)
        if (userSocketMap[player1.userId]) {
            ioInstance.to(userSocketMap[player1.userId]).emit("game-start", {
                gameId: game.gameId,
                playerNumber: 1,
                board: JSON.stringify(game.board), // Still send as string to client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                lastClickedTile: game.lastClickedTile,
                opponentName: player2.name,
                unrevealedMines: countUnrevealedMines(game.board)
            });
        }
        if (userSocketMap[player2.userId]) {
            ioInstance.to(userSocketMap[player2.userId]).emit("game-start", {
                gameId: game.gameId,
                playerNumber: 2,
                board: JSON.stringify(game.board), // Still send as string to client
                turn: game.turn,
                scores: game.scores,
                bombsUsed: game.bombsUsed,
                gameOver: game.gameOver,
                lastClickedTile: game.lastClickedTile,
                opponentName: player1.name,
                unrevealedMines: countUnrevealedMines(game.board)
            });
        }
        // Update Firestore to mark this event as sent
        await gameRef.update({ startedEventSent: true });
    }
    
    // Handle opponent reconnected logic:
    // This is handled by a special `reconnected` flag on the player object in Firestore
    if (player1?.reconnected && userSocketMap[player1.userId]) {
        ioInstance.to(userSocketMap[player1.userId]).emit("opponent-reconnected", {
            gameId: game.gameId,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            opponentName: player2?.name || "Opponent", // Correct opponent name
            lastClickedTile: game.lastClickedTile,
            unrevealedMines: countUnrevealedMines(game.board)
        });
        await gameRef.update({ 'players.0.reconnected': FieldValue.delete() });
    }
    if (player2?.reconnected && userSocketMap[player2.userId]) {
        ioInstance.to(userSocketMap[player2.userId]).emit("opponent-reconnected", {
            gameId: game.gameId,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            opponentName: player1?.name || "Opponent", // Correct opponent name
            lastClickedTile: game.lastClickedTile,
            unrevealedMines: countUnrevealedMines(game.board)
        });
        await gameRef.update({ 'players.1.reconnected': FieldValue.delete() });
    }


  }, (err) => {
    console.error(`Error with game observer for ${gameId}:`, err);
    // Clean up observer from the map if there's an error
    if (activeGameObservers[gameId]) {
      delete activeGameObservers[gameId];
    }
  });

  activeGameObservers[gameId] = unsubscribe; // Store the unsubscribe function
  console.log(`Firestore observer set up for game ID: ${gameId}`);
};

// Function to remove a Firestore observer
const removeGameObserver = (gameId) => {
  if (activeGameObservers[gameId]) {
    console.log(`Unsubscribing Firestore observer for game ID: ${gameId}`);
    activeGameObservers[gameId](); // Call the unsubscribe function
    delete activeGameObservers[gameId]; // Remove from map
  }
};

// Helper to update all connected clients with the current list of players
  const updatePlayerList = () => {
    // Filter out users who are currently in a game (players) or are observers
    // These users should not appear as 'available' in the lobby for new invites/find game.
    // Instead, they might appear in 'observable games'.
    const onlinePlayers = Object.keys(userSocketMap).map(id => {
        const s = io.sockets.sockets.get(userSocketMap[id]);
        if (s && !userGameMap[id]) { // Only include if socket exists and user is NOT in a game
            return {
                userId: id,
                name: s.displayName,
                socketId: s.id,
                isGuest: s.isGuest || false
            };
        }
        return null;
    }).filter(p => p !== null); // Filter out null entries

    io.emit("players-list", onlinePlayers);
    console.log("Player list updated. Current lobby players:", onlinePlayers.map(p => p.name));
  };


// === Socket.IO Logic ===
io.on("connection", async (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Passport.js attaches session to socket.request
  const user = socket.request.session?.passport?.user || null;
  let userId = user ? user.id : null;
  let userName = user ? user.displayName : null;
  let isGuestUser = user ? (user.isGuest || false) : false;

  // Temporarily store user info on the socket for easier access in handlers
  socket.userId = userId;
  socket.displayName = userName;
  socket.isGuest = isGuestUser;


  if (userId) {
    console.log(`[Connect] User ${userName} (${userId}) connected. Socket: ${socket.id}. Currently in game map? ${userGameMap[userId] ? 'Yes' : 'No'}.`);

    // Always update user-to-socket mapping with the latest socket ID
    userSocketMap[userId] = socket.id;
    // Emit this event *after* userSocketMap is updated and userId is confirmed
    socket.emit('authenticated-socket-ready');

    // Handle rejoining an existing game if user was previously in one or if it's stored in Firestore
    if (userGameMap[userId]) {
        const gameId = userGameMap[userId];
        const gameDoc = await db.collection(GAMES_COLLECTION_PATH).doc(gameId).get();

        if (gameDoc.exists) {
            const gameData = gameDoc.data();
            const playerIndex = gameData.players.findIndex(p => p.userId === userId);
            const isObserverInGame = gameData.observers?.some(o => o.userId === userId);

            if (playerIndex !== -1 && (gameData.status === 'active' || gameData.status === 'waiting_for_resume')) {
                // It's a player rejoining
                console.log(`Player ${userName} (${userId}) rejoining game ${gameId}.`);
                
                // Update Firestore to mark player as reconnected and set game status to active
                const updatePath = `players.${playerIndex}.reconnected`;
                await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                    [updatePath]: true,
                    status: 'active', // Set game status back to active
                    lastUpdated: Timestamp.now()
                });
                console.log(`Firestore updated for player ${userId} reconnect in game ${gameId}.`);

                // Join the game room
                socket.join(gameId);
                // The game-state-update and opponent-reconnected events will be handled by the observer
                // The initial game-start for the rejoining player is also sent by the observer
                setupGameObserver(gameId, io); // Ensure observer is active
            } else if (isObserverInGame) {
                // It's an observer rejoining
                console.log(`Observer ${userName} (${userId}) rejoining game ${gameId}.`);
                // Update the observer's socketId in Firestore (if you persist observers in Firestore)
                // For now, we update the in-memory game.observers if game is in `games` map,
                // otherwise `join-observer-game` will handle it.
                socket.join(gameId); // Join the game room
                setupGameObserver(gameId, io); // Ensure observer is active
                // Emit initial game state for observer (handled by the observer's game-state-update)
                // Notify others in the room that observer reconnected (optional, can be done by client if needed)
            } else {
                // User was mapped to game, but not as player or observer, or game is finished/invalid status
                console.log(`User ${userName} (${userId}) mapped to game ${gameId}, but not as player/observer or game status invalid. Clearing map.`);
                delete userGameMap[userId];
            }
        } else {
            console.log(`Game ${gameId} not found in Firestore for user ${userId}. Clearing map.`);
            delete userGameMap[userId]; // Clear map if game not found
        }
    } else {
        console.log(`User ${userName} (${userId}) not currently mapped to any game.`);
    }

    // Update all clients with the new player list after a user (re)connects
    updatePlayerList();

  } else {
    // If no session, wait for explicit login event from client
    console.log("User connected without an active session.");
  }


  // Client sends login event (for guests or after OAuth callback processes)
  socket.on("login", async ({ name, userId: clientUserId, isGuest }) => {
    // Prevent relogging if already authenticated via session
    if (socket.request.session?.passport?.user) {
        console.log(`User ${socket.request.session.passport.user.displayName} (${socket.request.session.passport.user.id}) already logged in. Ignoring 'login' event.`);
        socket.emit("auth-failure", { message: "Already logged in." });
        return;
    }

    // Assign userId and displayName from the client's login attempt
    userId = clientUserId;
    userName = name;
    isGuestUser = isGuest; // Corrected typo here

    userSocketMap[userId] = socket.id;
    socket.userId = userId; // Attach userId to socket for easy access
    socket.displayName = userName;
    socket.isGuest = isGuest; // Attach isGuest flag

    console.log(`User ${userName} (${userId}) logged in via 'login' event. Is Guest: ${isGuestUser}`);

    // If it's a guest login, manage their session manually
    if (isGuest) {
        try {
            await new Promise((resolve, reject) => {
                socket.request.session.regenerate((err) => {
                    if (err) return reject(err);
                    socket.request.session.passport = { user: { id: userId, displayName: userName, isGuest: true } };
                    socket.request.session.save((saveErr) => {
                        if (saveErr) return reject(saveErr);
                        resolve();
                    });
                });
            });
            console.log(`Guest session created for ${userId}, Session ID: ${socket.request.sessionID}`);
        } catch (error) {
            console.error("Error setting up guest session:", error);
            socket.emit("auth-failure", { message: "Failed to establish guest session." });
            return;
        }
    }

    // Fetch unfinished games for the user after login
    const unfinishedGames = [];
    // Check if the user was in a game that's still in userGameMap, consider it for resumption
    if (userGameMap[userId]) {
        const gameId = userGameMap[userId];
        const gameDoc = await db.collection(GAMES_COLLECTION_PATH).doc(gameId).get();
        if (gameDoc.exists) {
            const gameData = gameDoc.data();
            if (gameData.players.some(p => p.userId === userId) && (gameData.status === 'waiting_for_resume' || gameData.status === 'active')) {
                unfinishedGames.push({
                    gameId: gameData.gameId,
                    lastUpdated: gameData.lastUpdated,
                    opponentName: gameData.players.find(p => p.userId !== userId)?.name || 'Unknown Opponent',
                    scores: gameData.scores || {1:0, 2:0} // Ensure scores are sent
                });
                console.log(`Found unfinished game ${gameId} for user ${userId}.`);
                // If this is a rejoining player, and the other player is still connected
                const playerIndex = gameData.players.findIndex(p => p.userId === userId);
                const opponentIndex = playerIndex === 0 ? 1 : 0;
                 if (playerIndex !== -1 && gameData.players[opponentIndex] && userSocketMap[gameData.players[opponentIndex].userId]) {
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
                        [`players.${playerIndex}.reconnected`]: true,
                        status: 'active', // Set status back to in_progress
                        lastUpdated: Timestamp.now()
                    });
                    console.log(`Player ${userId} reconnected to game ${gameId}. Opponent will be notified.`);
                }
            }
        } else {
            delete userGameMap[userId];
            console.log(`Stale userGameMap entry for user ${userId} removed after login.`);
        }
    } else {
        // Also check Firestore directly for games marked waiting_for_resume where this user is a player
        const userGamesSnapshot = await db.collection(GAMES_COLLECTION_PATH)
            .where('players', 'array-contains', { userId: userId })
            .where('status', '==', 'waiting_for_resume')
            .get();

        userGamesSnapshot.forEach(doc => {
            const gameData = doc.data();
            unfinishedGames.push({
                gameId: gameData.gameId,
                lastUpdated: gameData.lastUpdated,
                opponentName: gameData.players.find(p => p.userId !== userId)?.name || 'Unknown Opponent',
                scores: gameData.scores || {1:0, 2:0} // Ensure scores are sent
            });
            userGameMap[userId] = gameData.gameId; // Populate userGameMap
            console.log(`Found an unmapped unfinished game ${gameData.gameId} for user ${userId} after login.`);
        });
    }

    // Set up observer for the game if it's active for this user
    if (userGameMap[userId]) {
        setupGameObserver(userGameMap[userId], io);
    }

    socket.emit("auth-success", { user: { id: userId, displayName: userName, isGuest: isGuestUser }, unfinishedGames });
    updatePlayerList();
  });


  // Handle game creation
  socket.on("create-game", async () => {
    if (!socket.userId) {
      socket.emit("auth-failure", { message: "Not authenticated." });
      return;
    }

    // If user is already in a game, prevent creating a new one
    if (userGameMap[socket.userId]) {
        const existingGameId = userGameMap[socket.userId];
        const existingGameDoc = await db.collection(GAMES_COLLECTION_PATH).doc(existingGameId).get();
        if (existingGameDoc.exists && existingGameDoc.data().status !== 'completed') {
            socket.emit("game-error", { message: `You are already in game ${existingGameId}. Resume it or wait for it to finish.` });
            console.log(`User ${socket.userId} tried to create new game but is already in game ${existingGameId}.`);
            return;
        }
    }

    const gameId = uuidv4();
    const newBoard = generateBoard();
    const initialUnrevealedMines = countUnrevealedMines(newBoard);

    const gameData = {
      gameId: gameId,
      board: JSON.stringify(newBoard), // Store as string in Firestore
      turn: 1, // Player 1 starts
      players: [{ userId: socket.userId, name: socket.displayName, playerNumber: 1 }], // Only player1 initially
      observers: [], // NEW: Initialize observers array
      scores: { 1: 0, 2: 0 },
      bombsUsed: { 1: false, 2: false },
      gameOver: false,
      waitingForBombCenter: false, // Initial state for bomb feature
      status: 'waiting_for_player', // Game is waiting for a second player
      lastUpdated: Timestamp.now(),
      lastClickedTile: { 1: null, 2: null },
      unrevealedMines: initialUnrevealedMines,
      startedEventSent: false // Flag to track if game-started event has been sent
    };

    try {
      await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set(gameData);
      userGameMap[socket.userId] = gameId; // Map current user to this game
      console.log(`Game ${gameId} created by ${socket.displayName}.`);

      setupGameObserver(gameId, io); // Set up observer for the new game

      socket.emit("game-created", { gameId, playerNumber: 1, board: JSON.stringify(newBoard) });
      updatePlayerList(); // Update lobby to remove creator
    } catch (error) {
      console.error("Error creating game:", error);
      socket.emit("game-error", { message: "Failed to create game." });
    }
  });

  // Handle inviting another player
  socket.on("invite-player", async ({ targetSocketId }) => {
    console.log(`Server: Received 'invite-player' from ${socket.displayName} (userId: ${socket.userId}) targeting socketId: ${targetSocketId}`);

    if (!socket.userId) { // Still ensure the inviter is authenticated
        socket.emit("game-error", { message: "You must be logged in to invite a player." });
        console.log(`Server: Invite failed for ${socket.displayName}: Not authenticated.`);
        return;
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);

    // Ensure the target exists and is not already in a game
    if (!targetSocket || !targetSocket.userId || userGameMap[targetSocket.userId]) {
        socket.emit("game-error", { message: "Invitee is not available or already in a game." });
        console.log(`Server: Invite failed for ${socket.displayName}: Target (${targetSocketId}) not available or in game.`);
        return;
    }

    // --- NEW LOGIC: Create a new PENDING game here ---
    const gameId = uuidv4(); // Generate a unique game ID for this potential game
    const inviterPlayer = {
        userId: socket.userId,
        name: socket.displayName,
        playerNumber: 1,
        socketId: socket.id // Store inviter's current socket ID
    };

    // Create a new game document in Firestore with a 'pending' status
    // This game will only become 'active' if the invite is accepted
    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId: gameId,
            status: 'pending', // New status: waiting for invitee to accept
            players: [inviterPlayer], // Add the inviter as Player 1
            createdAt: Timestamp.now(),
            lastUpdated: Timestamp.now(),
            board: [], // Initialize with empty board or a default, will be set on acceptance
            turn: 1, // Default, will be set on acceptance
            scores: { 1: 0, 2: 0 },
            bombsUsed: { 1: false, 2: false },
            gameOver: false,
            waitingForBombCenter: false,
            lastClickedTile: { 1: null, 2: null },
            startedEventSent: false // Track if game-start has been emitted for this game
        });
        console.log(`Server: Created pending game ${gameId} for inviter ${socket.displayName}`);

        // IMPORTANT: Temporarily map the inviter to this pending game.
        // This is crucial to prevent the inviter from inviting multiple people simultaneously
        // and to allow them to "undo" or track pending invites.
        userGameMap[socket.userId] = gameId;

        // Send invite to target, including the newly created gameId
        targetSocket.emit("game-invite", { gameId, inviterName: socket.displayName });
        console.log(`${socket.displayName} invited ${targetSocket.displayName} to pending game ${gameId}`);

    } catch (error) {
        console.error("Server: Error creating pending game or sending invite:", error);
        socket.emit("game-error", { message: "Failed to send invitation." });
        // Clean up userGameMap if game creation failed
        delete userGameMap[socket.userId];
    }
});

  // Handle declining an invitation
  socket.on("decline-invite", async ({ gameId }) => {
    if (!socket.userId) return; // Must be logged in

    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();

    if (!gameDoc.exists) {
        console.log(`Declined invite for non-existent game ${gameId}.`);
        return;
    }
    const gameData = gameDoc.data();
    const inviterPlayer = gameData.players[0];

    if (inviterPlayer && userSocketMap[inviterPlayer.userId]) {
        io.to(userSocketMap[inviterPlayer.userId]).emit("invite-rejected", { fromName: socket.displayName });
        console.log(`${socket.displayName} declined invite to game ${gameId} from ${inviterPlayer.name}`);
    } else {
        console.log(`${socket.displayName} declined invite to game ${gameId}, but inviter not found.`);
    }
  });


  // Tile Click Event (main game action)
  socket.on("tile-click", async ({ gameId, x, y }) => {
    if (!socket.userId) return;

    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();

    if (!gameDoc.exists) {
      console.log(`Game ${gameId} not found for tile-click.`);
      return;
    }

    const game = gameDoc.data();
    // Ensure board is deserialized if it came from Firestore
    game.board = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;

    const playerIndex = game.players.findIndex(p => p.userId === socket.userId);
    const playerNumber = playerIndex + 1; // Player 1 or 2

    if (game.gameOver || game.turn !== playerNumber || game.waitingForBombCenter) {
      console.log(`Invalid tile click in game ${gameId}: game over, not player's turn, or waiting for bomb target.`);
      return;
    }

    const newBoard = [...game.board.map(row => [...row])]; // Deep copy
    const tile = newBoard[y][x];

    if (tile.revealed) {
      console.log(`Tile (${x},${y}) already revealed.`);
      return;
    }

    // Update last clicked tile
    game.lastClickedTile = { ...game.lastClickedTile, [playerNumber]: { x, y } };

    // --- Start of Re-ordered and Corrected Logic ---
    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = playerNumber; // Assign owner to the mine
      game.scores[playerNumber]++; // Increment score for capturing a mine

      console.log(`[Tile Click] Player ${playerNumber} revealed a mine at (${x},${y}). New score: ${game.scores[playerNumber]}`);

      if (checkGameOver(game.scores)) {
          game.gameOver = true;
          game.status = 'completed';
          // Clear userGameMap for both players when game is over
          game.players.forEach(p => delete userGameMap[p.userId]); 
          removeGameObserver(gameId); // Remove Firestore observer for completed games
          updatePlayerList(); // Update lobby list
      }
      // Turn does NOT switch if a mine is revealed.
      // The turn will only switch after a non-mine tile is revealed.

    } else { // This block handles non-mine tiles
      const isBlankTile = tile.adjacentMines === 0;
      const noFlagsRevealedYet = game.scores[1] === 0 && game.scores[2] === 0;

      if (isBlankTile && noFlagsRevealedYet) {
        console.log(`[GAME RESTART TRIGGERED] Player ${playerNumber} (${socket.userId}) hit a blank tile at ${x},${y} before any flags were revealed. Restarting game ${gameId}.`);

        // Reset game state properties within the existing game object
        game.board = generateBoard(); // Generate a brand new board
        game.scores = { 1: 0, 2: 0 }; // Reset scores
        game.bombsUsed = { 1: false, 2: false }; // Reset bomb usage
        game.turn = 1; // Reset turn to player 1
        game.gameOver = false; // Game is no longer over
        game.lastClickedTile = { 1: null, 2: null }; // Reset lastClickedTile on restart
        game.status = 'active'; // Set status back to active

        // Ensure userGameMap is still set for both players if game restarts but isn't completed
        game.players.forEach(p => userGameMap[p.userId] = gameId); 
        updatePlayerList(); // Update lobby list to ensure players stay 'in game'

        try {
          // Update Firestore
          await gameRef.set({ // Use set with merge true for restart
              board: JSON.stringify(game.board),
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              turn: game.turn,
              gameOver: game.gameOver,
              lastClickedTile: game.lastClickedTile, // Save lastClickedTile
              status: 'active', // Game is active after restart
              lastUpdated: Timestamp.now(),
              winnerId: null,
              loserId: null
          }, { merge: true });
          console.log(`Game ${gameId} restarted and updated in Firestore.`);
        } catch (error) {
            console.error("Error restarting game in Firestore:", error);
        }

        // The game-state-update (and game-start if needed) will be emitted by the observer
        return; // Important: Exit after restarting
      }

      // If not a mine and not a restart condition on a blank tile, then it's a normal reveal
      revealRecursive(newBoard, x, y);
      game.board = newBoard; // Update game board
      game.turn = game.turn === 1 ? 2 : 1; // Turn switches only for non-mine reveals
    }
    // --- End of Re-ordered and Corrected Logic ---

    // Update game state in Firestore
    try {
        const serializedBoard = JSON.stringify(game.board);
        await gameRef.update({ // Use update for partial updates
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed, // Ensure bombsUsed is always saved
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile, // Save lastClickedTile
            status: game.status, // Use the newStatus
            lastUpdated: Timestamp.now(),
            winnerId: game.gameOver ? (game.scores[1] > game.scores[2] ? game.players[0].userId : game.players[1].userId) : null,
            loserId: game.gameOver ? (game.scores[1] < game.scores[2] ? game.players[0].userId : game.players[1].userId) : null
        });
        console.log(`Game ${gameId} updated in Firestore (tile-click). Status: ${game.status}`);
    } catch (error) {
        console.error("Error updating game in Firestore (tile-click):", error);
    }
    // The game state update will be pushed by the Firestore observer to all clients
  });

  // Use Bomb Event
  socket.on("use-bomb", async ({ gameId }) => {
    if (!socket.userId) return;

    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();

    if (!gameDoc.exists) {
      console.log(`Game ${gameId} not found for use-bomb.`);
      return;
    }

    const game = gameDoc.data();
    const playerIndex = game.players.findIndex(p => p.userId === socket.userId);
    const playerNumber = playerIndex + 1;

    if (game.gameOver || game.turn !== playerNumber || game.bombsUsed[playerNumber]) {
      console.log(`Invalid use-bomb in game ${gameId}: game over, not player's turn, or bomb already used.`);
      return;
    }

    // Set waitingForBombCenter to true and update bombsUsed for the player
    game.waitingForBombCenter = true;
    game.bombsUsed[playerNumber] = true; // Mark bomb as used immediately

    try {
      await gameRef.update({
        waitingForBombCenter: game.waitingForBombCenter,
        bombsUsed: game.bombsUsed,
        lastUpdated: Timestamp.now()
      });
      console.log(`Player ${playerNumber} activated bomb mode in game ${gameId}.`);
      // State update will be pushed by the observer (which includes waitingForBombCenter flag)
    } catch (error) {
      console.error(`Error updating game ${gameId} for use-bomb:`, error);
    }
  });


  // Bomb Center Selected Event
  socket.on("bomb-center", async ({ gameId, x, y }) => {
    if (!socket.userId) return;

    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();

    if (!gameDoc.exists) {
      console.log(`Game ${gameId} not found for bomb-target.`);
      return;
    }

    const game = gameDoc.data();
    // Ensure board is deserialized if it came from Firestore
    game.board = typeof game.board === 'string' ? JSON.parse(game.board) : game.board;

    const playerIndex = game.players.findIndex(p => p.userId === socket.userId);
    const playerNumber = playerIndex + 1;

    if (game.gameOver || game.turn !== playerNumber || !game.waitingForBombCenter || !game.bombsUsed[playerNumber]) {
      console.log(`Invalid bomb-target in game ${gameId}: game over, not player's turn, not in bomb mode, or bomb not used.`);
      return;
    }

    const newBoard = [...game.board.map(row => [...row])]; // Deep copy

    // Calculate the 5x5 area around the target
    const affectedTiles = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < WIDTH && ny >= 0 && ny < HEIGHT) {
          affectedTiles.push({ x: nx, y: ny });
        }
      }
    }

    for (const { x: tx, y: ty } of affectedTiles) {
      const tile = newBoard[ty][tx];
      if (!tile.revealed) {
        tile.revealed = true;
        tile.owner = playerNumber; // Mark owner for scoring
      }
    }

    // Update last clicked tile for the current player using bomb center
    game.lastClickedTile = { ...game.lastClickedTile, [playerNumber]: { x, y } };

    // After bomb, scores are recalculated, turn switches, and bomb mode ends
    game.scores[playerNumber] = calculateScore(newBoard, playerNumber);
    game.turn = playerNumber === 1 ? 2 : 1; // Switch turn
    game.waitingForBombCenter = false; // Exit bomb targeting mode

    // Check for game over condition after bomb: if either player has enough score
    if (checkGameOver(game.scores)) {
        game.gameOver = true;
        game.status = 'completed';
        console.log(`Game ${gameId} ended after bomb: scores P1: ${game.scores[1]}, P2: ${game.scores[2]}.`);
        // Clear userGameMap for both players when game is over
        game.players.forEach(p => delete userGameMap[p.userId]); 
        removeGameObserver(gameId); // Remove Firestore observer for completed games
        updatePlayerList(); // Update lobby list
    }

    try {
      await gameRef.update({
        board: JSON.stringify(newBoard),
        turn: game.turn,
        scores: game.scores,
        waitingForBombCenter: game.waitingForBombCenter,
        bombsUsed: game.bombsUsed, // Ensure bombsUsed is saved
        gameOver: game.gameOver, // Update game over status
        lastClickedTile: game.lastClickedTile, // Save lastClickedTile
        status: game.status,
        lastUpdated: Timestamp.now()
      });
      console.log(`Player ${playerNumber} used bomb at (${x},${y}) in game ${gameId}.`);
      // State update will be pushed by the observer
    } catch (error) {
      console.error(`Error updating game ${gameId} after bomb-target:`, error);
    }
  });

  // Restart Game Event (Manual Restart Button)
  socket.on("restart-game", async ({ gameId }) => {
    if (!socket.userId) return;

    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();
    if (!gameDoc.exists) {
      console.log(`Game ${gameId} not found for restart.`);
      return;
    }
    const game = gameDoc.data();
    
    // Check if the user requesting restart is a player in this game
    const playerInGame = game.players.find(p => p.userId === socket.userId);
    if (!playerInGame) {
        console.warn(`User ${socket.userId} tried to restart game ${gameId} but is not a player.`);
        return;
    }

    console.log(`Manual restart requested by ${socket.displayName} for game ${gameId}.`);

    const newBoard = generateBoard();

    // Update game state in Firestore
    try {
        await gameRef.set({ // Use set with merge true for restart
            gameId: gameId, // Ensure gameId is preserved
            board: JSON.stringify(newBoard),
            scores: { 1: 0, 2: 0 },
            bombsUsed: { 1: false, 2: false },
            turn: 1,
            gameOver: false,
            lastClickedTile: { 1: null, 2: null }, // Reset lastClickedTile on restart
            status: 'active', // Game is active after restart
            lastUpdated: Timestamp.now(),
            players: game.players, // Keep existing players
            observers: [], // Clear observers on restart, they need to rejoin
            startedEventSent: false // Reset flag for new game start
        }, { merge: true });
        console.log(`Game ${gameId} restarted and updated in Firestore.`);
    } catch (error) {
        console.error("Error restarting game in Firestore:", error); // Log the full error object
        socket.emit("game-error", { message: "Failed to restart game due to a server error." });
        return;
    }

    // Ensure userGameMap entries are still there for both players since the game is restarting, not ending
    game.players.forEach(p => userGameMap[p.userId] = gameId); 
    updatePlayerList(); // Update lobby list
    // The game-state-update (and game-started) will be emitted by the observer
  });

 // Leave Game Event (Player voluntarily leaves)
socket.on("leave-game", async ({ gameId }) => {
  const user = socket.request.session?.passport?.user || null;
  const userId = user ? user.id : null;

  if (!userId || !gameId) {
      console.warn(`Attempt to leave game failed: userId or gameId missing. userId: ${userId}, gameId: ${gameId}`);
      return;
  }

  const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
  const gameDoc = await gameRef.get();

  if (!gameDoc.exists) {
      console.warn(`Game ${gameId} not found in Firestore for leave-game request from ${userId}.`);
      if (userGameMap[userId] === gameId) {
          delete userGameMap[userId]; // Clean up stale map entry
          console.log(`Cleaned stale userGameMap entry for ${userId} to game ${gameId}.`);
      }
      updatePlayerList(); // Update lobby list
      return;
  }

  const gameData = gameDoc.data();
  const playerInGame = gameData.players.find(p => p.userId === userId);

  if (playerInGame) {
    // Remove from userGameMap for the leaving user only
    delete userGameMap[userId];
    console.log(`User ${userId} (${playerInGame.name}) left game ${gameId}.`);

    // Notify the opponent if one exists and is still connected
    const opponentPlayer = gameData.players.find(p => p.userId !== userId);
    if (opponentPlayer && userSocketMap[opponentPlayer.userId]) {
        io.to(userSocketMap[opponentPlayer.userId]).emit("opponent-left");
        console.log(`Notified opponent ${opponentPlayer.name} that their partner left.`);
    }

    // Always set game status in Firestore to 'waiting_for_resume' when a player voluntarily leaves.
    // The game should only be 'completed' by explicit game over conditions (win/loss).
    try {
      await gameRef.update({
          status: 'waiting_for_resume',
          lastUpdated: Timestamp.now()
      });
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

  updatePlayerList(); // Update lobby list
});

// Socket Disconnect Event (e.g., browser tab closed, network drop)
socket.on("disconnect", async () => {
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

  updatePlayerList(); // Update lobby list

  // Check if the disconnected user was in a game
  if (disconnectedUserId && userGameMap[disconnectedUserId]) {
    const gameId = userGameMap[disconnectedUserId];
    const gameRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameRef.get();

    if (gameDoc.exists) {
        const game = gameDoc.data();
        
        // If the game is already over, no need to change status
        if (game.gameOver) {
            console.log(`Game ${gameId} is already over. No status change needed on disconnect.`);
            // No need to removeGameObserver here, it's done when game becomes 'completed'
            delete userGameMap[disconnectedUserId]; // Clear userGameMap entry for finished games
            return;
        }

        // Check if the disconnected user was a player or an observer
        const wasPlayer = game.players.some(p => p.userId === disconnectedUserId);
        const wasObserver = game.observers?.some(o => o.userId === disconnectedUserId);

        if (wasPlayer) {
            // Player disconnected: update game status to waiting_for_resume
            console.log(`[Disconnect] Player ${disconnectedUserId} disconnected from game ${gameId}. Setting status to 'waiting_for_resume'.`);
            try {
              await gameRef.update({
                status: 'waiting_for_resume', // Set game status to waiting_for_resume
                lastUpdated: Timestamp.now()
              });
              console.log(`Game ${gameId} status set to 'waiting_for_resume' in Firestore.`);
            } catch (error) {
              console.error("[Disconnect] Error updating game status to 'waiting_for_resume' on disconnect:", error);
            }

            // Notify the opponent if one exists and is still connected
            const remainingPlayer = game.players.find(p => p.userId !== disconnectedUserId);
            if (remainingPlayer && userSocketMap[remainingPlayer.userId]) { // Check if opponent's socket is still active
                io.to(userSocketMap[remainingPlayer.userId]).emit("opponent-left"); // Inform the opponent
                console.log(`Notified opponent ${remainingPlayer.name} that their partner disconnected.`);
            } else {
                // If no remaining player is connected, notify observers that a player disconnected
                if (game.observers && game.observers.length > 0) {
                     io.to(gameId).emit("player-disconnected", { name: socket.displayName || disconnectedUserId });
                }
            }
            // userGameMap entry for player is kept to allow resumption

        } else if (wasObserver) {
            // Observer disconnected: remove from observers array in Firestore
            console.log(`[Disconnect] Observer ${disconnectedUserId} disconnected from game ${gameId}.`);
            try {
                await gameRef.update({
                    observers: FieldValue.arrayRemove({ userId: disconnectedUserId, name: socket.displayName || disconnectedUserId })
                });
                console.log(`Observer ${disconnectedUserId} removed from game ${gameId} in Firestore.`);
                io.to(gameId).emit("observer-left", { name: socket.displayName || disconnectedUserId }); // Notify others
            } catch (error) {
                console.error("Error removing observer on disconnect:", error);
            }
            delete userGameMap[disconnectedUserId]; // Clear observer's game mapping
        }

    } else {
      // If game wasn't found in Firestore but userGameMap pointed to it, it might be a stale entry. Clear it.
      delete userGameMap[disconnectedUserId];
      console.log(`[Disconnect] User ${disconnectedUserId} was mapped to game ${gameId} but game not found in Firestore. Clearing userGameMap.`);
    }
  }
});
});

app.use("/", router); // Use the router for your routes

// --- Server Startup ---
const PORT = process.env.PORT || 3001; // Use Render's PORT env var, or 3001 for local dev
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
