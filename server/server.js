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
const crypto = require("crypto");

const { getBestAIMove } = require('./ai.js');

// --- Firebase Admin SDK Imports ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { FirestoreStore } = require('@google-cloud/connect-firestore');


const app = express();
app.use(express.json()); // Enable parsing of JSON body for guest login
// IMPORTANT: Add this line to trust proxy headers when deployed to Render
app.set('trust proxy', 1);
const server = http.createServer(app);

const Jimp = require("jimp");

function distributeMinesForParsedBoard(board) {
  const height = board.length;
  const width = board[0].length;

  const countMinesAround = (bx, by) => {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ny = by + dy;
        const nx = bx + dx;
        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
          if (board[ny][nx].isMine || board[ny][nx].ownerTeam !== null) {
            count++;
          }
        }
      }
    }
    return count;
  };

  // Helper: check if placing a mine at (px, py) violates any number constraint
  const wouldViolateConstraints = (px, py) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const adj = board[ny][nx];
          if (adj.revealed && adj.adjacentMines > 0) {
            // If this neighbor already has or will exceed its allowed mines
            if (countMinesAround(nx, ny) >= adj.adjacentMines) {
              return true;
            }
          }
        }
      }
    }
    return false;
  };

  // 1. Strict constraint pass: Iteratively satisfy each number safely
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 30) {
    changed = false;
    iterations++;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = board[y][x];
        if (tile.revealed && tile.adjacentMines > 0) {
          const currentMines = countMinesAround(x, y);
          const needed = tile.adjacentMines - currentMines;

          if (needed > 0) {
            let unrevealedNeighbors = [];
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const ny = y + dy;
                const nx = x + dx;
                if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                  const neighbor = board[ny][nx];
                  if (!neighbor.revealed && !neighbor.isMine && neighbor.ownerTeam === null) {
                    if (!unrevealedNeighbors.some(n => n.x === nx && n.y === ny)) {
                      unrevealedNeighbors.push({ x: nx, y: ny });
                    }
                  }
                }
              }
            }

            if (unrevealedNeighbors.length > 0) {
              unrevealedNeighbors.sort(() => Math.random() - 0.5);
              for (let pos of unrevealedNeighbors) {
                if (countMinesAround(x, y) >= tile.adjacentMines) break;
                if (!board[pos.y][pos.x].isMine && !wouldViolateConstraints(pos.x, pos.y)) {
                  board[pos.y][pos.x].isMine = true;
                  changed = true;
                }
              }
            }
          }
        }
      }
    }
  }

  // 2. Controlled Guarantee Pass: Fix any remaining deficits WITHOUT breaking upper limits (like a '1' touching 2)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = board[y][x];
      if (tile.revealed && tile.adjacentMines > 0) {
        let currentMines = countMinesAround(x, y);
        let needed = tile.adjacentMines - currentMines;

        if (needed > 0) {
          for (let dy = -1; dy <= 1 && needed > 0; dy++) {
            for (let dx = -1; dx <= 1 && needed > 0; dx++) {
              if (dx === 0 && dy === 0) continue;
              const ny = y + dy;
              const nx = x + dx;
              if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                const neighbor = board[ny][nx];
                if (!neighbor.revealed && !neighbor.isMine && neighbor.ownerTeam === null) {
                  // ONLY place if it doesn't cause any neighbor to exceed its max limit
                  if (!wouldViolateConstraints(nx, ny)) {
                    neighbor.isMine = true;
                    needed--;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // 3. Identify all cells adjacent to ANY revealed number tile (Restricted Zone)
  const restrictedCells = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (board[y][x].revealed) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              restrictedCells.add(`${nx},${ny}`);
            }
          }
        }
      }
    }
  }

  // 4. Safe Random Fill: Place remaining background mines outside number zones
  let currentMinesCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (board[y][x].isMine || board[y][x].ownerTeam !== null) {
        currentMinesCount++;
      }
    }
  }

  let minesToPlace = Math.max(0, MINES - currentMinesCount);
  let safety = 0;

  while (minesToPlace > 0 && safety < 5000) {
    safety++;
    const rx = Math.floor(Math.random() * width);
    const ry = Math.floor(Math.random() * height);

    const target = board[ry][rx];
    const cellKey = `${rx},${ry}`;

    if (target.revealed || target.isMine || target.ownerTeam !== null) continue;
    if (restrictedCells.has(cellKey)) continue;

    target.isMine = true;
    minesToPlace--;
  }

  // Fallback fill if quota wasn't met
  if (minesToPlace > 0) {
    for (let y = 0; y < height && minesToPlace > 0; y++) {
      for (let x = 0; x < width && minesToPlace > 0; x++) {
        if (!board[y][x].revealed && !board[y][x].isMine && board[y][x].ownerTeam === null) {
          board[y][x].isMine = true;
          minesToPlace--;
        }
      }
    }
  }

  // 5. Final Pass: Recalculate adjacentMines ONLY for unrevealed tiles. Lock OCR numbers permanently.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!board[y][x].revealed) {
        board[y][x].adjacentMines = countMinesAround(x, y);
      }
    }
  }

  return board;
}
async function parseScreenshotToBoard(base64Image) {
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(base64Data, 'base64');
  
  const image = await Jimp.read(imageBuffer);
  
  const width = 16;
  const height = 16;
  const cellWidth = image.bitmap.width / width;
  const cellHeight = image.bitmap.height / height;

  const initialScores = { 1: 0, 2: 0 };

  const board = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null,
      ownerTeam: null,
    }))
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tileX = Math.floor(x * cellWidth);
      const tileY = Math.floor(y * cellHeight);
      const cW = Math.floor(cellWidth);
      const cH = Math.floor(cellHeight);

      let darkBluePx = 0; // For 4: (0, 0, 154) -> blue channel around 120-180
      let pureBluePx = 0; // For 1: (0, 0, 255) -> blue channel > 200
      let greenPx = 0;
      let redPx = 0;
      let brownPx = 0;   // For 5
      let cyanPx = 0;    // For 6
      let blackPx = 0;   // For 7
      let olivePx = 0;   // For 8

      const startX = tileX + Math.floor(cW * 0.25);
      const endX = tileX + Math.floor(cW * 0.75);
      const startY = tileY + Math.floor(cH * 0.25);
      const endY = tileY + Math.floor(cH * 0.75);

      for (let py = startY; py < endY; py++) {
        for (let px = startX; px < endX; px++) {
          const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(px, py));

          if (r < 60 && g < 60 && b < 60) {
            blackPx++; // 7 (Black)
          } else if (r < 40 && g < 40 && b >= 100 && b <= 180) {
            darkBluePx++; // 4 -> Matches (0, 0, 154) range
          } else if (r < 40 && g < 40 && b > 200) {
            pureBluePx++; // 1 -> Matches (0, 0, 255) range
          } else if (g > 110 && g > r && g > b) {
            greenPx++;  // 2 (Green)
          } else if (r > 140 && g < 90 && b < 90) {
            redPx++;    // 3 (Red)
          } else if (r > 110 && r < 160 && g > 60 && g < 110 && b < 60) {
            brownPx++;  // 5 (Brown)
          } else if (r < 60 && g > 110 && b > 110) {
            cyanPx++;   // 6 (Cyan)
          } else if (r > 90 && r < 140 && g > 90 && g < 140 && b > 60 && b < 110) {
            olivePx++;  // 8 (Olive)
          }
        }
      }

      iif (isYellowBg) {
        board[y][x].revealed = true;

        if (olivePx >= 3) board[y][x].adjacentMines = 8;
        else if (blackPx >= 3) board[y][x].adjacentMines = 7;
        else if (cyanPx >= 3) board[y][x].adjacentMines = 6;
        else if (brownPx >= 3) board[y][x].adjacentMines = 5;
        else if (pureBluePx >= 3) board[y][x].adjacentMines = 1;  // <--- CHECK 1 FIRST! If it has bright blue, it's 1.
        else if (darkBluePx >= 8) board[y][x].adjacentMines = 4;  // <--- CHECK 4 AFTERWARDS, requiring higher pixel density (8+)
        else if (redPx >= 3) board[y][x].adjacentMines = 3;
        else if (greenPx >= 3) board[y][x].adjacentMines = 2;
        else board[y][x].adjacentMines = 0;
      } else {
        board[y][x].revealed = false;
      }
    }
  }

  distributeMinesForParsedBoard(board);

  return { board, initialScores };
}
async function parseScreenshotToBoard(base64Image) {
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
  const imageBuffer = Buffer.from(base64Data, 'base64');
  
  const image = await Jimp.read(imageBuffer);
  
  const width = 16;
  const height = 16;
  const cellWidth = image.bitmap.width / width;
  const cellHeight = image.bitmap.height / height;

  const initialScores = { 1: 0, 2: 0 };

  const board = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null,
      ownerTeam: null,
    }))
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tileX = Math.floor(x * cellWidth);
      const tileY = Math.floor(y * cellHeight);
      const cW = Math.floor(cellWidth);
      const cH = Math.floor(cellHeight);

      let bluePx = 0;
      let greenPx = 0;
      let redPx = 0;
      let purplePx = 0;
      let navyPx = 0;    // Specifically for 4 (dark/navy blue)
      let brownPx = 0;   // For 5
      let cyanPx = 0;    // For 6
      let blackPx = 0;   // For 7
      let olivePx = 0;   // For 8
      let darkPolePx = 0;

      const startX = tileX + Math.floor(cW * 0.25);
      const endX = tileX + Math.floor(cW * 0.75);
      const startY = tileY + Math.floor(cH * 0.25);
      const endY = tileY + Math.floor(cH * 0.75);

      for (let py = startY; py < endY; py++) {
        for (let px = startX; px < endX; px++) {
          const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(px, py));

          if (r < 75 && g < 75 && b < 75) darkPolePx++;
          // Black / Dark text (7)
          else if (r < 60 && g < 60 && b < 60) blackPx++;
          // Navy / Dark Blue text (4) -> Deep blue where red and green are low
          else if (b > 80 && r < 80 && g < 80) navyPx++;
          // Brown / Dark Orange text (5)
          else if (r > 100 && r < 160 && g > 60 && g < 110 && b < 60) brownPx++;
          // Cyan / Teal text (6)
          else if (r < 50 && g > 110 && b > 110) cyanPx++;
          // Olive Green text (8)
          else if (r > 80 && r < 140 && g > 90 && g < 150 && b < 50) olivePx++;
          else if (r > 110 && b > 110 && g < 80) purplePx++;
          // Bright Blue text (1) -> Lighter, higher green/red mix than navy
          else if (b > 130 && b > r + 20) bluePx++;
          else if (g > 110 && g > r + 20 && g > b + 20) greenPx++;
          else if (r > 140 && g < 80 && b < 80) redPx++;
        }
      }

      // FLAG OVERRIDE
      const hasFlagPole = darkPolePx >= 1;
      const isBlueFlag = hasFlagPole && bluePx >= 1;
      const isRedFlag = hasFlagPole && redPx >= 1;

      if (isRedFlag || isBlueFlag) {
        const team = isRedFlag ? 1 : 2;
        board[y][x].revealed = true;
        board[y][x].isMine = true;
        board[y][x].ownerTeam = team;
        initialScores[team]++;
        continue;
      }

      // Sample interior background
      const samplePoints = [
        Jimp.intToRGBA(image.getPixelColor(tileX + Math.floor(cW * 0.25), tileY + Math.floor(cH * 0.25))),
        Jimp.intToRGBA(image.getPixelColor(tileX + Math.floor(cW * 0.75), tileY + Math.floor(cH * 0.25))),
        Jimp.intToRGBA(image.getPixelColor(tileX + Math.floor(cW * 0.25), tileY + Math.floor(cH * 0.75))),
        Jimp.intToRGBA(image.getPixelColor(tileX + Math.floor(cW * 0.50), tileY + Math.floor(cH * 0.50)))
      ];

      const isYellowBg = samplePoints.some(px => 
        px.r > 130 && px.g > 110 && (px.r + px.g) / 2 > px.b + 30
      );

      if (isYellowBg) {
        board[y][x].revealed = true;

        if (olivePx >= 2) board[y][x].adjacentMines = 8;
        else if (blackPx >= 2) board[y][x].adjacentMines = 7;
        else if (cyanPx >= 2) board[y][x].adjacentMines = 6;
        else if (brownPx >= 2) board[y][x].adjacentMines = 5;
        else if (navyPx >= 2) board[y][x].adjacentMines = 4; // <--- Catches the dark blue 4
        else if (purplePx >= 1 || (bluePx > 0 && redPx > 0)) board[y][x].adjacentMines = 4;
        else if (redPx >= 2) board[y][x].adjacentMines = 3;
        else if (greenPx >= 2) board[y][x].adjacentMines = 2;
        else if (bluePx >= 1) board[y][x].adjacentMines = 1;
        else board[y][x].adjacentMines = 0;
      } else {
        board[y][x].revealed = false;
      }
    }
  }

  distributeMinesForParsedBoard(board);

  return { board, initialScores };
}

// New global data structures for robust player tracking across reconnections
const userSocketMap = {}; // Maps userId to current socket.id (e.g., Google ID, Facebook ID, Guest ID)
// userGameMap maps userId to an object { gameId: string, role: 'player' | 'observer' }
const userGameMap = {};   // Maps userId to the gameId and role they are currently in

// Configure CORS for Express
// MUST match your frontend Render URL exactly
app.use(
  cors({
    origin: [
      "https://minesweeper-flags-frontend.onrender.com",
      "https://localhost",
      "http://localhost",
      "capacitor://localhost"
    ],
    credentials: true, // Allow cookies to be sent cross-origin
  })
);

// Add this route to your existing Express app
router.get('/api/get-client-ip', async (req, res) => {
    try {
        let clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        if (Array.isArray(clientIp)) {
            clientIp = clientIp[0];
        }

        if (clientIp && clientIp.includes(':') && !clientIp.startsWith('::')) {
            clientIp = clientIp.split(':').slice(0, -1).join(':');
        }
        if (clientIp === '::1' || clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
            console.warn("Client IP is localhost. Attempting to fetch public IP via ipify.org from backend.");
            const response = await fetch('https://api.ipify.org?format=json');
            if (!response.ok) {
                throw new Error(`Failed to fetch public IP from ipify.org: ${response.status}`);
            }
            const data = await response.json();
            clientIp = data.ip;
        }

        if (!clientIp || clientIp.includes('::ffff:')) {
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

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID;
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

let db;
let sessionMiddleware;
let io;

const WIDTH = 16;
const HEIGHT = 16;
const MINES = 51;
const APP_ID = process.env.RENDER_APP_ID || "minesweeper-flags-default-app";
const GAMES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/minesweeperGames`;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  console.log(`[Firebase Init] Service Account Project ID: ${serviceAccount.project_id}`);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = getFirestore();

  sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "super-secret-fallback-key-for-dev",
    resave: false,
    saveUninitialized: false,
    store: new FirestoreStore({
      dataset: db,
      kind: 'express-sessions',
    }),
    cookie: {
      sameSite: "none",
      secure: true,
      maxAge: 1000 * 60 * 60 * 24,
      proxy: true,
    },
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  console.log("Firebase Admin SDK and FirestoreStore initialized.");

  io = new Server(server, {
    cors: {
      origin: [
        "https://minesweeper-flags-frontend.onrender.com",
        "https://localhost",
        "capacitor://localhost",
        "http://localhost"
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.use((socket, next) => {
    const session = socket.request.session;

    if (session && session.passport && session.passport.user) {
      if (typeof session.passport.user === 'object') {
        socket.request.user = session.passport.user;
      }
      return next();
    }

    if (session && session.user) {
      socket.request.user = session.user;
      return next();
    }

    const { fallbackUserId, fallbackName } = socket.handshake.query;

    if (fallbackUserId && fallbackName) {
      console.log(`[Socket Fallback Auth] Authenticating Safari client: ${fallbackName} (${fallbackUserId})`);

      socket.request.user = {
        id: fallbackUserId,
        displayName: fallbackName,
        name: fallbackName
      };

      if (!socket.request.session) socket.request.session = {};
      if (!socket.request.session.passport) socket.request.session.passport = {};
      socket.request.session.passport.user = fallbackUserId;

      return next();
    }

    console.log("[Socket Auth Error] Connection rejected: No session verification vectors found.");
    return next(new Error("Authentication required"));
  });

} catch (error) {
  console.error("Failed to initialize Firebase Admin SDK or FirestoreStore.", error);
  process.exit(1);
}


passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, displayName: profile.displayName });
}));

passport.use(new FacebookStrategy({
  clientID: FACEBOOK_CLIENT_ID,
  clientSecret: FACEBOOK_CLIENT_SECRET,
  callbackURL: "https://minesweeper-flags-backend.onrender.com/auth/facebook/callback",
  profileFields: ['id', 'displayName', 'photos', 'email']
},
function(accessToken, refreshToken, profile, cb) {
  cb(null, { id: profile.id, displayName: profile.displayName });
}));

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});


app.get("/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

app.get("/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Google auth:", err);
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      console.log(`[Session Save] Session successfully saved after Google auth. New Session ID: ${req.sessionID}`);

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

app.get("/auth/facebook",
  passport.authenticate("facebook", { scope: ['public_profile'] })
);

app.get("/auth/facebook/callback",
  passport.authenticate("facebook", {
    failureRedirect: "https://minesweeper-flags-frontend.onrender.com/login-failed",
  }),
  (req, res) => {
    req.session.save((err) => {
      if (err) {
        console.error("Error saving session after Facebook auth:", err);
        return res.redirect(`https://minesweeper-flags-frontend.onrender.com/auth/callback-failure?message=${encodeURIComponent(err.message || 'Authentication failed due to session error.')}`);
      }
      console.log(`[Session Save] Session successfully saved after Facebook auth. New Session ID: ${req.sessionID}`);

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

app.post("/auth/guest", (req, res) => {
    const { guestId } = req.body;
    if (!guestId) {
        return res.status(400).json({ message: "Guest ID and name are required." });
    }

    req.session.passport = { user: { id: guestId, displayName: `Guest_${guestId.substring(6, 11)}` }};

    req.session.save((err) => {
        if (err) {
            console.error("Error saving guest session:", err);
            return res.status(500).json({ message: "Failed to create guest session." });
        }
        console.log(`Guest session saved: ${guestId}`);
        res.status(200).json({ user: req.session.passport.user });
    });
});

app.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); }
    req.session.destroy((destroyErr) => {
      if (destroyErr) { return next(destroyErr); }
      res.clearCookie("connect.sid", {
          path: '/',
          secure: true,
          sameSite: 'none',
          proxy: true,
      });
      console.log("User logged out and session destroyed.");
      res.status(200).send("Logged out successfully");
    });
  });
});

app.get("/me", (req, res) => {
  if (req.isAuthenticated() && req.user) {
    res.json({ user: req.user });
  } else if (req.session?.passport?.user) {
      res.json({ user: req.session.passport.user });
  }
  else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.get("/login-failed", (req, res) => {
  res.send("Login failed");
});

let players = [];
let games = {};
const pendingInvites = {};
const pending2v2Acceptances = {};

const lobbyMessages = [];
const MAX_LOBBY_MESSAGES = 100;

const generateBoard = (safeX = null, safeY = null) => {
  const board = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => ({
      isMine: false,
      revealed: false,
      adjacentMines: 0,
      owner: null,
      ownerTeam: null,
    }))
  );

  let minesPlaced = 0;
  while (minesPlaced < MINES) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);

    // Skip placement if tile is within safe click radius of the first click
    if (safeX !== null && safeY !== null && Math.abs(x - safeX) <= 1 && Math.abs(y - safeY) <= 1) {
      continue;
    }

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

const revealArea = (board, cx, cy, playerNumber, playerTeam, scores) => {
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
            tile.ownerTeam = playerTeam;
            scores[playerTeam]++;
          } else {
            revealRecursive(board, x, y);
          }
        }
      }
    }
  }
};

function clearAllRelatedInvitesForUsers(userIds, currentInviteId) {
    Object.keys(pendingInvites).forEach(targetUserId => {
        if (!pendingInvites[targetUserId]) return;

        Object.keys(pendingInvites[targetUserId]).forEach(invId => {
            const inviteObj = pendingInvites[targetUserId][invId];
            
            const involvesUser = 
                userIds.includes(inviteObj.senderId) || 
                userIds.includes(targetUserId) ||
                (inviteObj.invitedPlayersInfo && inviteObj.invitedPlayersInfo.some(p => userIds.includes(p.userId)));

            if (involvesUser || invId === currentInviteId) {
                delete pendingInvites[targetUserId][invId];
            }
        });

        const clientSocketId = userSocketMap[targetUserId];
        if (clientSocketId) {
            io.to(clientSocketId).emit("update-invites", pendingInvites[targetUserId] || {});
        }
    });

    Object.keys(pending2v2Acceptances).forEach(invId => {
        const acceptanceObj = pending2v2Acceptances[invId];
        const involvesTrackerUser = userIds.some(uid => acceptanceObj.requiredPlayers?.has(uid));
        if (involvesTrackerUser || invId === currentInviteId) {
            delete pending2v2Acceptances[invId];
        }
    });
}

async function processAiTurn(gameId) {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const nextPlayer = game.players.find(p => p.number === game.turn);
    if (!nextPlayer || !nextPlayer.isAi) return;

    setTimeout(async () => {
        if (game.gameOver) return;
        
        const aiMove = getBestAIMove(game.board);
        if (!aiMove) return;

        const x = aiMove.c;
        const y = aiMove.r;

        game.lastClickedTile = { ...game.lastClickedTile, [nextPlayer.number]: { x, y } };

        const aiTile = game.board[y][x];
        if (aiTile.revealed || aiTile.flagged) return;

        let aiHitMine = false;
        const aiTeam = nextPlayer.team || nextPlayer.number;

        if (aiTile.isMine) {
            aiTile.revealed = true;
            aiTile.owner = nextPlayer.number;
            aiTile.ownerTeam = aiTeam;
            game.scores[aiTeam] = (game.scores[aiTeam] || 0) + 1;

            if (checkGameOver(game.scores)) {
                game.gameOver = true;
            } else {
                aiHitMine = true;
            }
        } else {
            revealRecursive(game.board, x, y);
            
            if (game.gameType === '1v1') {
                game.turn = game.turn === 1 ? 2 : 1;
            } else if (game.gameType === '2v2') {
                game.turn = getNext2v2Turn(game.turn);
            }
        }

        const cachedBoardString = JSON.stringify(game.board);

        io.to(gameId).emit("board-update", {
            gameId: game.gameId,
            board: cachedBoardString,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            observers: game.observers,
            clickStartTime: game.clickStartTime
        });

        const newStatus = game.gameOver ? 'completed' : 'active';
        db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: cachedBoardString,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            status: newStatus,
            moves: game.moves,
            lastUpdated: Timestamp.now(),
            winnerTeam: game.gameOver ? (game.scores[1] > game.scores[2] ? 1 : 2) : null,
            loserTeam: game.gameOver ? (game.scores[1] < game.scores[2] ? 1 : 2) : null
        }, { merge: true }).catch(error => {
            console.error("Error updating AI move in Firestore:", error);
        });

        if (aiHitMine && !game.gameOver) {
            processAiTurn(gameId);
        }
    }, 800);
}

const checkGameOver = (scores) => {
  return scores[1] >= 26 || scores[2] >= 26;
};

const getNext2v2Turn = (currentTurn) => {
  switch (currentTurn) {
    case 1: return 3;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 1;
  }
};

const getPlayersWithAI = () => {
    const aiBot = {
        userId: 'ai_bot_player_id',
        name: '🤖 Minesweeper Bot',
        socketId: null,
        isAi: true
    };
    if (!players.some(p => p.userId === aiBot.userId)) {
        players.push(aiBot);
    }
    return players;
};

const emitLobbyPlayersList = () => {
    const activePlayers = getPlayersWithAI();
    const playersWithStatus = players.map(p => {
        const gameMapping = userGameMap[p.userId];
        let opponentName = null;
        let playerNames = {}; 
        let teamName = null;

        if (gameMapping && games[gameMapping.gameId]) {
            const game = games[gameMapping.gameId];
            if (game.gameType === '1v1') {
                opponentName = game.players.find(player => player.userId !== p.userId)?.name;
            } else { 
                const myPlayer = game.players.find(player => player.userId === p.userId);
                if (myPlayer) {
                    teamName = `Team ${myPlayer.team}`;
                }
                playerNames = { 
                    player1Name: game.players.find(pl => pl.number === 1)?.name,
                    player2Name: game.players.find(pl => pl.number === 2)?.name,
                    player3Name: game.players.find(pl => pl.number === 3)?.name,
                    player4Name: game.players.find(pl => pl.number === 4)?.name,
                };
            }
        }

        return {
            id: p.id,
            name: p.name,
            userId: p.userId, 
            gameId: gameMapping ? gameMapping.gameId : null,
            role: gameMapping ? gameMapping.role : null,
            gameType: gameMapping && games[gameMapping.gameId] ? games[gameMapping.gameId].gameType : null,
            opponentName: opponentName, 
            teamName: teamName, 
            playerNames: playerNames 
        };
    });
    io.emit("players-list", playersWithStatus);
};


io.on("connection", (socket) => {
  let user = socket.request.session?.passport?.user || socket.request.user || null;
  let userId = user ? (user.id || socket.request.user?.id) : null;
  let userName = user ? (user.displayName || user.name) : null;

  if (!userId && socket.handshake.auth && socket.handshake.auth.user) {
    const authUser = socket.handshake.auth.user;
    userId = authUser.id || authUser.guestId || `guest_${Date.now()}`;
    userName = authUser.displayName || authUser.name || "Guest";
  }

  if (userId) {
    userSocketMap[userId] = socket.id;
    socket.emit('authenticated-socket-ready');

    if (userGameMap[userId]) {
        const gameMapping = userGameMap[userId];
        const gameId = gameMapping.gameId;
        const role = gameMapping.role;
        let game = games[gameId];

        if (!game) {
            db.collection(GAMES_COLLECTION_PATH).doc(gameId).get().then(doc => {
                if (doc.exists && (doc.data().status === 'active' || doc.data().status === 'waiting_for_resume')) {
                    const gameData = doc.data();
                    const deserializedBoard = JSON.parse(gameData.board);

                    game = {
                        gameId: gameData.gameId,
                        gameType: gameData.gameType || '1v1',
                        board: deserializedBoard,
                        scores: gameData.scores,
                        bombsUsed: gameData.bombsUsed,
                        turn: gameData.turn,
                        moves: gameData.moves || [],
                        gameOver: gameData.gameOver,
                        lastClickedTile: gameData.lastClickedTile || {},
                        players: [],
                        messages: gameData.messages || []
                    };

                    game.observers = (gameData.observers || []).filter(obs =>
                        ![gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(obs.userId)
                    );

                    const playerUserIds = [gameData.player1_userId, gameData.player2_userId];
                    const playerNames = {
                        1: gameData.player1_name || "Player 1",
                        2: gameData.player2_name || "Player 2",
                    };
                    if (game.gameType === '2v2') {
                        playerUserIds.push(gameData.player3_userId, gameData.player4_userId);
                        playerNames[3] = gameData.player3_name || "Player 3";
                        playerNames[4] = gameData.player4_name || "Player 4";
                    }

                    game.players = playerUserIds.map((pUid, index) => {
                        const playerNum = index + 1;
                        let playerObj = players.find(p => p.userId === pUid);
                        if (!playerObj) {
                            playerObj = { userId: pUid, name: playerNames[playerNum], number: playerNum };
                            players.push(playerObj);
                        }
                        playerObj.socketId = userSocketMap[pUid] || null;
                        playerObj.team = (playerNum === 1 || playerNum === 2) ? 1 : 2;
                        return playerObj;
                    });

                    games[gameId] = game;

                    if (gameData.status === 'waiting_for_resume') {
                        doc.ref.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true }).catch(e => console.error("Error updating game status on resume:", e));
                    }

                    if (role === 'player') {
                        const playerInGame = game.players.find(p => p.userId === userId);
                        if (playerInGame) {
                            socket.join(gameId);
                            io.to(playerInGame.socketId).emit("game-start", {
                                gameId: game.gameId,
                                gameType: game.gameType,
                                playerNumber: playerInGame.number,
                                board: JSON.stringify(game.board),
                                turn: game.turn,
                                scores: game.scores,
                                bombsUsed: game.bombsUsed,
                                gameOver: game.gameOver,
                                lastClickedTile: game.lastClickedTile,
                                opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
                                gameChat: game.messages,
                                observers: game.observers,
                                player1Name: playerNames[1],
                                player2Name: playerNames[2],
                                player3Name: playerNames[3],
                                player4Name: playerNames[4],
                            });
                            io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });

                            game.players.filter(p => p.userId !== userId && p.socketId).forEach(opponent => {
                                io.to(opponent.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                            });
                        }
                    } else if (role === 'observer') {
                        const observerInGame = game.observers.find(o => o.userId === userId);
                        if (!observerInGame) {
                            game.observers.push({ userId, name: userName, socketId: socket.id });
                            doc.ref.update({ observers: FieldValue.arrayUnion({ userId, name: userName }) });
                        } else {
                            observerInGame.socketId = socket.id;
                        }
                        socket.join(gameId);
                        io.to(socket.id).emit("game-start", {
                            gameId: game.gameId,
                            gameType: game.gameType,
                            playerNumber: 0,
                            board: JSON.stringify(game.board),
                            turn: game.turn,
                            scores: game.scores,
                            bombsUsed: game.bombsUsed,
                            gameOver: game.gameOver,
                            lastClickedTile: game.lastClickedTile,
                            opponentName: "N/A",
                            gameChat: game.messages,
                            observers: game.observers,
                            player1Name: playerNames[1],
                            player2Name: playerNames[2],
                            player3Name: playerNames[3],
                            player4Name: playerNames[4],
                        });
                        io.to(gameId).emit("observer-joined", { name: userName, userId: userId });
                    }
                    emitLobbyPlayersList();
                } else {
                    delete userGameMap[userId];
                    emitLobbyPlayersList();
                }
            }).catch(e => console.error("Error fetching game from Firestore on reconnect:", e));
        } else {
            if (role === 'player') {
                const playerInGame = game.players.find(p => p.userId === userId);
                if (playerInGame) {
                    playerInGame.socketId = socket.id;
                    socket.join(gameId);
                    io.to(socket.id).emit("game-start", {
                        gameId: game.gameId,
                        gameType: game.gameType,
                        playerNumber: playerInGame.number,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
                        gameChat: game.messages,
                        observers: game.observers,
                        player1Name: game.players.find(pl => pl.number === 1)?.name || "Player 1",
                        player2Name: game.players.find(pl => pl.number === 2)?.name || "Player 2",
                        player3Name: game.players.find(pl => pl.number === 3)?.name,
                        player4Name: game.players.find(pl => pl.number === 4)?.name,
                    });
                    io.to(gameId).emit("player-reconnected", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });
                    game.players.filter(p => p.userId !== userId && p.socketId).forEach(opponent => {
                        io.to(opponent.socketId).emit("opponent-reconnected", { name: playerInGame.name });
                    });
                }
            } else if (role === 'observer') {
                const observerInGame = game.observers.find(o => o.userId === userId);
                if (observerInGame) {
                    observerInGame.socketId = socket.id;
                    socket.join(gameId);
                    io.to(socket.id).emit("game-start", {
                        gameId: game.gameId,
                        gameType: game.gameType,
                        playerNumber: 0,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: "N/A",
                        gameChat: game.messages,
                        observers: game.observers,
                        player1Name: game.players.find(pl => pl.number === 1)?.name || "Player 1",
                        player2Name: game.players.find(pl => pl.number === 2)?.name || "Player 2",
                        player3Name: game.players.find(pl => pl.number === 3)?.name,
                        player4Name: game.players.find(pl => pl.number === 4)?.name,
                    });
                    io.to(gameId).emit("observer-joined", { name: userName, userId: userId });
                }
            }
        }
    }
  }

  socket.on("invite-midgame-setup", async (data) => {
    const inviterUser = socket.request.session?.passport?.user || socket.request.user || null;
    const inviterUserId = inviterUser ? (inviterUser.id || socket.request.user?.id) : null;
    const inviterPlayer = players.find((p) => p.userId === inviterUserId);

    const targetPlayer = players.find((p) => p.id === data.targetSocketId);
    if (!targetPlayer) {
      socket.emit("game-error", "Target player no longer connected.");
      return;
    }

    let parsedData = { board: null, initialScores: { 1: 0, 2: 0 } };
    if (data.screenshot) {
      try {
        parsedData = await parseScreenshotToBoard(data.screenshot);
      } catch (err) {
        console.error("Failed to parse screenshot:", err);
      }
    }

    const inviteId = crypto.randomUUID();

    if (!pendingInvites[targetPlayer.userId]) {
      pendingInvites[targetPlayer.userId] = {};
    }

    pendingInvites[targetPlayer.userId][inviteId] = {
      inviteId,
      senderId: inviterUserId,
      senderName: inviterPlayer ? inviterPlayer.name : "Opponent",
      targetSocketId: data.targetSocketId,
      gameType: '1v1_midgame',
      turn: data.turn,
      myColor: data.myColor,
      bombsUsed: data.bombsUsed,
      screenshot: data.screenshot,
      initialBoard: parsedData.board,       // <--- Ensures board array is saved
      initialScores: parsedData.initialScores // <--- Ensures scores are saved
    };

    io.to(data.targetSocketId).emit("game-invite", pendingInvites[targetPlayer.userId][inviteId]);
  });

  socket.on("join-lobby", (name) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || name) : name; 

    if (!userId) {
        socket.emit("join-error", "Authentication required to join lobby.");
        return;
    }

    userSocketMap[userId] = socket.id;

    players = players.filter(p => p.userId !== userId);
    players.push({ id: socket.id, userId: userId, name: userName });
    socket.emit("lobby-joined", userName);
    socket.emit("initial-lobby-messages", lobbyMessages);

    emitLobbyPlayersList();
    socket.emit("request-observable-games");
  });

  socket.on("send-lobby-message", (message) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userName = user ? (user.displayName || user.name) : 'Anonymous';
    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = { sender: userName, text: message, timestamp: timestamp };
    lobbyMessages.push(fullMessage);
    if (lobbyMessages.length > MAX_LOBBY_MESSAGES) {
      lobbyMessages.shift();
    }
    io.emit("receive-lobby-message", fullMessage);
  });


  socket.on("request-unfinished-games", async () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || 'Unknown Player') : 'Unknown Player';

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch games.");
        return;
    }

    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('gameOver', '==', false)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let unfinishedGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            const isPlayer1 = gameData.player1_userId === userId;
            const isPlayer2 = gameData.player2_userId === userId;
            const isPlayer3 = gameData.gameType === '2v2' && gameData.player3_userId === userId;
            const isPlayer4 = gameData.gameType === '2v2' && gameData.player4_userId === userId;

            if (isPlayer1 || isPlayer2 || isPlayer3 || isPlayer4) {
                let myPlayerNumber = null;
                if (isPlayer1) myPlayerNumber = 1;
                else if (isPlayer2) myPlayerNumber = 2;
                else if (isPlayer3) myPlayerNumber = 3;
                else if (isPlayer4) myPlayerNumber = 4;

                let opponentName = null;
                if (gameData.gameType === '1v1') {
                    opponentName = myPlayerNumber === 1 ? gameData.player2_name : gameData.player1_name;
                }

                unfinishedGames.push({
                    gameId: gameData.gameId,
                    board: gameData.board,
                    gameType: gameData.gameType || '1v1',
                    playerNumber: myPlayerNumber,
                    opponentName: opponentName,
                    player1Name: gameData.player1_name,
                    player2Name: gameData.player2_name,
                    player3Name: gameData.player3_name,
                    player4Name: gameData.player4_name,
                    status: gameData.status,
                    lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                    scores: gameData.scores
                });
            }
        });

        socket.emit("receive-unfinished-games", unfinishedGames);

    } catch (error) {
        console.error("Error fetching unfinished games for user:", userId, error);
        socket.emit("join-error", "Failed to load your unfinished games.");
    }
  });

  socket.on("request-observable-games", async () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;

    if (!userId) {
        socket.emit("join-error", "Authentication required to fetch observable games.");
        return;
    }

    try {
        const gamesQuery = await db.collection(GAMES_COLLECTION_PATH)
            .where('gameOver', '==', false)
            .where('status', 'in', ['active', 'waiting_for_resume'])
            .get();

        let observableGames = [];

        gamesQuery.forEach(doc => {
            const gameData = doc.data();
            const isPlayer = [gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(userId);

            if (!isPlayer) {
                const gameInMem = games[gameData.gameId];
                let hasActiveParticipants = false;

                if (gameInMem) {
                    const playersActive = gameInMem.players.some(p => p.socketId);
                    const anyObserverActive = gameInMem.observers.some(o => o.socketId);

                    hasActiveParticipants = playersActive || anyObserverActive;
                }

                if (hasActiveParticipants) {
                    const alreadyObserving = userGameMap[userId] && userGameMap[userId].gameId === gameData.gameId && userGameMap[userId].role === 'observer';
                    if (!alreadyObserving) {
                         observableGames.push({
                            gameId: gameData.gameId,
                            gameType: gameData.gameType || '1v1',
                            player1Name: gameData.player1_name || "Player 1",
                            player2Name: gameData.player2_name || "Player 2",
                            player3Name: gameData.player3_name,
                            player4Name: gameData.player4_name,
                            scores: gameData.scores,
                            status: gameData.status,
                            lastUpdated: gameData.lastUpdated ? gameData.lastUpdated.toDate().toLocaleString() : 'N/A',
                            activeParticipants: (gameInMem ? (gameInMem.players.filter(p => p.socketId).length + gameInMem.observers.filter(o => o.socketId).length) : 0)
                        });
                    }
                }
            }
        });

        socket.emit("receive-observable-games", observableGames);

    } catch (error) {
        console.error("Error fetching observable games for user:", userId, error);
        socket.emit("join-error", "Failed to load observable games.");
    }
  });


socket.on("resume-game", async ({ gameId }) => {
  const user = socket.request.session?.passport?.user || socket.request.user || null;
  const userId = user ? (user.id || socket.request.user?.id) : null;
  const userName = user ? (user.displayName || user.name || 'Unknown Player') : 'Unknown Player';

  if (!userId) {
    socket.emit("join-error", "Authentication required to resume game.");
    return;
  }

  userSocketMap[userId] = socket.id;

  try {
    const gameDocRef = db.collection(GAMES_COLLECTION_PATH).doc(gameId);
    const gameDoc = await gameDocRef.get();

    if (!gameDoc.exists) {
      socket.emit("join-error", "Game not found or already ended.");
      if (userGameMap[userId] && userGameMap[userId].gameId === gameId) {
          delete userGameMap[userId];
      }
      return;
    }

    const gameData = gameDoc.data();

    const allPlayerUserIds = [gameData.player1_userId, gameData.player2_userId];
    if (gameData.gameType === '2v2') {
        allPlayerUserIds.push(gameData.player3_userId, gameData.player4_userId);
    }
    if (!allPlayerUserIds.includes(userId)) {
      socket.emit("join-error", "You are not a participant in this game.");
      return;
    }

    let currentPlayerNumber = null;
    if (gameData.player1_userId === userId) currentPlayerNumber = 1;
    else if (gameData.player2_userId === userId) currentPlayerNumber = 2;
    else if (gameData.player3_userId === userId) currentPlayerNumber = 3;
    else if (gameData.player4_userId === userId) currentPlayerNumber = 4;

    const playerNamesForClient = {
        1: gameData.player1_name || "Player 1",
        2: gameData.player2_name || "Player 2",
        3: gameData.player3_name,
        4: gameData.player4_name,
    };

    if (games[gameId]) {
      const existingGame = games[gameId];

      existingGame.players.forEach(player => {
          player.socketId = userSocketMap[player.userId] || null;
      });
      existingGame.observers.forEach(observer => {
          observer.socketId = userSocketMap[observer.userId] || null;
      });

      const currentPlayerInGame = existingGame.players.find(p => p.userId === userId);

      if (!currentPlayerInGame) {
          socket.emit("join-error", "Internal error: You are a participant but not found in in-memory game players.");
          return;
      }

      if (currentPlayerInGame.socketId === socket.id) {
          socket.join(gameId);
          userGameMap[userId] = { gameId, role: 'player' };

          io.to(currentPlayerInGame.socketId).emit("game-start", {
              gameId: existingGame.gameId,
              gameType: existingGame.gameType,
              playerNumber: currentPlayerNumber,
              board: JSON.stringify(existingGame.board),
              turn: existingGame.turn,
              scores: existingGame.scores,
              bombsUsed: existingGame.bombsUsed,
              gameOver: existingGame.gameOver,
              lastClickedTile: existingGame.lastClickedTile,
              opponentName: existingGame.gameType === '1v1' ? existingGame.players.find(op => op.userId !== userId)?.name : "N/A",
              gameChat: existingGame.messages,
              observers: existingGame.observers,
              player1Name: playerNamesForClient[1],
              player2Name: playerNamesForClient[2],
              player3Name: playerNamesForClient[3],
              player4Name: playerNamesForClient[4],
          });

          existingGame.players.filter(p => p.userId !== userId && p.socketId).forEach(player => {
              io.to(player.socketId).emit("opponent-reconnected", { name: userName });
          });
          io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' });
          return;
      } else {
          socket.emit("join-error", "Your game session is active on another connection or tab.");
          return;
      }
    }

    const deserializedBoard = JSON.parse(gameData.board);

    const game = {
      gameId: gameData.gameId,
      gameType: gameData.gameType || '1v1',
      board: deserializedBoard,
      scores: gameData.scores,
      bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
      turn: gameData.turn,
      gameOver: gameData.gameOver,
      lastClickedTile: gameData.lastClickedTile || {},
      players: [],
      messages: gameData.messages || []
    };

    game.observers = (gameData.observers || []).filter(obs =>
        ![gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(obs.userId)
    );

    const playerUids = [gameData.player1_userId, gameData.player2_userId];
    if (game.gameType === '2v2') {
        playerUids.push(gameData.player3_userId, gameData.player4_userId);
    }

    game.players = playerUids.map((pUid, index) => {
        const playerNum = index + 1;
        let playerObj = players.find(p => p.userId === pUid);
        if (!playerObj) {
            playerObj = { userId: pUid, name: playerNamesForClient[playerNum], number: playerNum };
            players.push(playerObj);
        }
        playerObj.socketId = (pUid === userId) ? socket.id : (userSocketMap[pUid] || null);
        playerObj.team = (playerNum === 1 || playerNum === 2) ? 1 : 2;
        return playerObj;
    });

    game.observers.forEach(observer => {
        observer.socketId = userSocketMap[observer.userId] || null;
    });

    games[gameId] = game;

    game.players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });
    game.observers.forEach(o => userGameMap[o.userId] = { gameId, role: 'observer' });

    if (gameData.status === 'waiting_for_resume') {
      await gameDocRef.set({ status: 'active', lastUpdated: Timestamp.now() }, { merge: true });
    }

    const currentPlayerInGame = game.players.find(p => p.userId === userId);

    if (currentPlayerInGame && currentPlayerInGame.socketId) {
      socket.join(gameId);
      io.to(currentPlayerInGame.socketId).emit("game-start", {
        gameId: game.gameId,
        gameType: game.gameType,
        playerNumber: currentPlayerInGame.number,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== userId)?.name : "N/A",
        gameChat: game.messages,
        observers: game.observers,
        player1Name: playerNamesForClient[1],
        player2Name: playerNamesForClient[2],
        player3Name: playerNamesForClient[3],
        player4Name: playerNamesForClient[4],
      });
      io.to(gameId).emit("player-reconnected", { name: userName, userId: userId, role: 'player' });
    }

    game.players.filter(p => p.userId !== userId && p.socketId).forEach(player => {
        io.to(player.socketId).emit("opponent-reconnected", { name: userName });
    });

    emitLobbyPlayersList();

  } catch (error) {
    console.error("Error resuming game:", error);
    socket.emit("join-error", "Failed to resume game. " + error.message);
    if (userGameMap[userId] && userGameMap[userId].gameId === gameId) {
        delete userGameMap[userId];
    }
  }
});

  socket.on("observe-game", async ({ gameId }) => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || 'Anonymous Observer') : 'Anonymous Observer';

    if (!userId) {
        socket.emit("join-error", "Authentication required to observe game.");
        return;
    }

    if (userGameMap[userId]) {
        socket.emit("join-error", "You are already in a game or observing another.");
        return;
    }

    userSocketMap[userId] = socket.id;

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
        const isPlayerInGame = [gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(userId);
        if (isPlayerInGame) {
            socket.emit("join-error", "You are a player in this game, not an observer.");
            return;
        }

        let game = games[gameId];
        if (!game) {
            const deserializedBoard = JSON.parse(gameData.board);

            const playerNamesForClient = {
                1: gameData.player1_name || "Player 1",
                2: gameData.player2_name || "Player 2",
                3: gameData.player3_name,
                4: gameData.player4_name,
            };

            game = {
                gameId: gameData.gameId,
                gameType: gameData.gameType || '1v1',
                board: deserializedBoard,
                scores: gameData.scores,
                bombsUsed: gameData.bombsUsed || { 1: false, 2: false },
                turn: gameData.turn,
                gameOver: gameData.gameOver,
                lastClickedTile: gameData.lastClickedTile || {},
                players: [],
                messages: gameData.messages || []
            };

            game.observers = (gameData.observers || []).filter(obs =>
                ![gameData.player1_userId, gameData.player2_userId, gameData.player3_userId, gameData.player4_userId].includes(obs.userId)
            );

            const playerUids = [gameData.player1_userId, gameData.player2_userId];
            if (game.gameType === '2v2') {
                playerUids.push(gameData.player3_userId, gameData.player4_userId);
            }

            game.players = playerUids.map((pUid, index) => {
                const playerNum = index + 1;
                let playerObj = players.find(p => p.userId === pUid);
                if (!playerObj) {
                    playerObj = { userId: pUid, name: playerNamesForClient[playerNum], number: playerNum };
                    players.push(playerObj);
                }
                playerObj.socketId = userSocketMap[pUid] || null;
                playerObj.team = (playerNum === 1 || playerNum === 2) ? 1 : 2;
                return playerObj;
            });

            games[gameId] = game;
        }

        const newObserver = { userId, name: userName, socketId: socket.id };
        const existingObserverIndex = game.observers.findIndex(o => o.userId === userId);
        if (existingObserverIndex === -1) {
            game.observers.push(newObserver);
        } else {
            game.observers[existingObserverIndex].socketId = socket.id;
        }

        await gameDocRef.update({
            observers: FieldValue.arrayUnion({ userId, name: userName })
        });

        socket.join(gameId);

        userGameMap[userId] = { gameId, role: 'observer' };

        io.to(socket.id).emit("game-start", {
            gameId: game.gameId,
            gameType: game.gameType,
            playerNumber: 0,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            opponentName: "N/A",
            gameChat: game.messages,
            observers: game.observers,
            player1Name: game.players.find(pl => pl.number === 1)?.name || "Player 1",
            player2Name: game.players.find(pl => pl.number === 2)?.name || "Player 2",
            player3Name: game.players.find(pl => pl.number === 3)?.name,
            player4Name: game.players.find(pl => pl.number === 4)?.name,
        });

        io.to(gameId).emit("observer-joined", { name: userName, userId: userId });

        emitLobbyPlayersList();
        socket.emit("request-observable-games");
    } catch (error) {
        console.error("Error observing game:", error);
        socket.emit("join-error", "Failed to observe game. " + error.message);
    }
  });

  socket.on("get-game-replay", async ({ gameId }) => {
    try {
        const gameDoc = await db.collection(GAMES_COLLECTION_PATH).doc(gameId).get();

        if (!gameDoc.exists) {
            socket.emit("game-error", "Replay not found.");
            return;
        }

        const gameData = gameDoc.data();

        socket.emit("receive-game-replay", {
            gameId: gameData.gameId,
            gameType: gameData.gameType || '1v1',
            player1Name: gameData.player1_name,
            player2Name: gameData.player2_name,
            player3Name: gameData.player3_name,
            player4Name: gameData.player4_name,
            winnerTeam: gameData.winnerTeam,
            finalScores: gameData.scores,
            moves: gameData.moves || [],
            board: gameData.board
        });

    } catch (error) {
        console.error("Error fetching game replay:", error);
        socket.emit("game-error", "Failed to retrieve game replay.");
    }
});


socket.on("invite-player", async ({ targetSocketIds, gameType }) => {
    const inviterUser = socket.request.session?.passport?.user || socket.request.user || null;
    const inviterUserId = inviterUser ? (inviterUser.id || socket.request.user?.id) : null;
    const inviterPlayer = players.find((p) => p.userId === inviterUserId);

    if (!inviterPlayer) {
        socket.emit("join-error", "Invite failed: Inviter profile could not be found.");
        return;
    }

    const firstTarget = Array.isArray(targetSocketIds) ? targetSocketIds[0] : targetSocketIds;
    const isAiInvite = 
        gameType === '1v1' && (
            firstTarget === 'ai_bot_player_id' || 
            firstTarget === null || 
            !targetSocketIds || 
            (typeof firstTarget === 'string' && firstTarget.includes('ai'))
        );

    if (isAiInvite) {
        const gameId = uuidv4();
        const board = generateBoard();
        const player1 = inviterPlayer;
        const player2 = { userId: 'ai_bot_player_id', name: '🤖 Minesweeper Bot', socketId: null, isAi: true };

        const newGame = {
            gameId,
            gameType: '1v1',
            board,
            scores: { 1: 0, 2: 0 },
            bombsUsed: { 1: false, 2: false },
            turn: 1,
            gameOver: false,
            lastClickedTile: {},
            players: [
                { userId: player1.userId, name: player1.name, number: 1, socketId: socket.id, team: 1 },
                { userId: player2.userId, name: player2.name, number: 2, socketId: null, isAi: true, team: 2 }
            ],
            messages: [],
            observers: [],
            moves: []
        };

        games[gameId] = newGame;
        userGameMap[player1.userId] = { gameId, role: 'player' };

        db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            gameId,
            gameType: '1v1',
            player1_userId: player1.userId,
            player1_name: player1.name,
            player2_userId: player2.userId,
            player2_name: player2.name,
            board: JSON.stringify(board),
            scores: newGame.scores,
            bombsUsed: newGame.bombsUsed,
            turn: newGame.turn,
            gameOver: false,
            status: 'active',
            lastUpdated: Timestamp.now()
        }).catch(err => console.error("Error saving AI game to Firestore:", err));

        socket.join(gameId);
        socket.emit("game-start", {
            gameId,
            gameType: '1v1',
            playerNumber: 1,
            board: JSON.stringify(board),
            turn: 1,
            scores: newGame.scores,
            bombsUsed: newGame.bombsUsed,
            gameOver: false,
            lastClickedTile: {},
            opponentName: player2.name,
            gameChat: [],
            observers: [],
            player1Name: player1.name,
            player2Name: player2.name
        });

        emitLobbyPlayersList();
        return;
    }
    const invitedPlayersData = [];
    const allInvitedUserIds = [];

    if (gameType === '1v1') {
        const targetSocketId = firstTarget;
        const invitedPlayer = players.find((p) => p.id === targetSocketId);
        if (!invitedPlayer) {
            socket.emit("join-error", "Invite failed: AI Bot or player not found.");
            return;
        }
        invitedPlayersData.push(invitedPlayer);
        allInvitedUserIds.push(invitedPlayer.userId);

    } else if (gameType === '2v2') {
        for (const sId of targetSocketIds) {
            const p = players.find(player => player.id === sId);
            if (!p) {
                io.to(inviterPlayer.id).emit("invite-rejected", { fromName: "Server", reason: "One or more invited players not found." });
                return;
            }
            invitedPlayersData.push(p);
            allInvitedUserIds.push(p.userId);
        }
        if (invitedPlayersData.length !== 3) {
            io.to(inviterPlayer.id).emit("invite-rejected", { fromName: "Server", reason: "Incorrect number of players for 2v2 game." });
            return;
        }
    } else {
        return;
    }

    const allInvolvedUserIds = [inviterUserId, ...allInvitedUserIds];
    const playersAlreadyInGame = allInvolvedUserIds.filter(uid => userGameMap[uid]);

    if (playersAlreadyInGame.length > 0) {
        const namesInGame = playersAlreadyInGame.map(uid => players.find(p => p.userId === uid)?.name || uid).join(', ');
        const reason = `One or more players (${namesInGame}) are already in a game.`;
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: "Server", reason: reason });
        allInvitedUserIds.forEach(invitedUid => {
            if (userGameMap[invitedUid] && userSocketMap[invitedUid]) {
                io.to(userSocketMap[invitedUid]).emit("invite-rejected", { fromName: inviterPlayer.name, reason: "You are already in another game." });
            }
        });
        return;
    }

    const inviteId = uuidv4();

    for (const invitedP of invitedPlayersData) {
        if (!pendingInvites[invitedP.userId]) {
            pendingInvites[invitedP.userId] = {};
        }
        pendingInvites[invitedP.userId][inviteId] = {
            inviteId,
            senderId: inviterUserId,
            senderName: inviterPlayer.name,
            gameId: null,
            gameType: gameType,
            targetSocketIds: targetSocketIds,
            timestamp: Date.now(),
            status: 'pending',
            invitedPlayersInfo: invitedPlayersData.map(p => ({ userId: p.userId, name: p.name, socketId: p.id }))
        };
    }

    if (gameType === '2v2') {
        pending2v2Acceptances[inviteId] = {
            inviterId: inviterUserId,
            acceptedUsers: new Set([inviterUserId]),
            requiredPlayers: new Set(allInvolvedUserIds)
        };
    }

    for (const invitedP of invitedPlayersData) {
        const targetSocketId = invitedP.id;
        if (targetSocketId) {
            io.to(targetSocketId).emit("game-invite", pendingInvites[invitedP.userId][inviteId]);
        }
    }
    io.to(inviterPlayer.id).emit("invite-sent", { message: "Invite sent successfully." });
  });

  socket.on("respond-invite", async ({ inviteId, gameIdFromClient, accept }) => {
    const respondingUser = socket.request.session?.passport?.user || socket.request.user || null;
    const respondingUserId = respondingUser ? (respondingUser.id || socket.request.user?.id) : null;
    const respondingPlayer = players.find((p) => p.userId === respondingUserId);

    if (!respondingPlayer) {
        socket.emit("join-error", "Response failed: Your player profile could not be found.");
        return;
    }

    const originalInvite = pendingInvites[respondingUserId]?.[inviteId];

    if (!originalInvite) {
        socket.emit("game-error", "Invalid or expired invite.");
        return;
    }

    delete pendingInvites[respondingUserId][inviteId];
    socket.emit("update-invites", pendingInvites[respondingUserId] || {});

    if (userGameMap[respondingUserId]) {
        socket.emit("game-error", `You are already in game ${userGameMap[respondingUserId].gameId}. Leave that game first.`);
        return;
    }

    const inviterPlayer = players.find((p) => p.userId === originalInvite.senderId);
    if (!inviterPlayer) {
        socket.emit("game-error", "Inviter not found. They might have disconnected.");
        return;
    }

    let allPlayerUserIdsInInvite = [inviterPlayer.userId];
    if (originalInvite.gameType === '2v2' && Array.isArray(originalInvite.invitedPlayersInfo)) {
        originalInvite.invitedPlayersInfo.forEach(p => {
            if (!allPlayerUserIdsInInvite.includes(p.userId)) {
                allPlayerUserIdsInInvite.push(p.userId);
            }
        });
    }

    const playersCurrentlyInOtherGame = allPlayerUserIdsInInvite.filter(uid => userGameMap[uid] && userGameMap[uid].gameId !== gameIdFromClient);
    if (playersCurrentlyInOtherGame.length > 0) {
        const namesInGame = playersCurrentlyInOtherGame.map(uid => players.find(p => p.userId === uid)?.name || uid).join(', ');
        const reason = `Game could not start: One or more players (${namesInGame}) are already in another game.`;
        io.to(respondingPlayer.id).emit("invite-rejected", { fromName: inviterPlayer.name, reason });
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: respondingPlayer.name, reason });

        if (originalInvite.gameType === '2v2') {
            allPlayerUserIdsInInvite.forEach(invitedUid => {
                if (invitedUid !== inviterPlayer.userId && invitedUid !== respondingUserId) {
                    const otherInvitedSocket = userSocketMap[invitedUid];
                    if (otherInvitedSocket) {
                        io.to(otherInvitedSocket).emit("invite-rejected", { fromName: inviterPlayer.name, reason: `Game failed to start: ${reason}` });
                    }
                }
            });
        }
        if (pending2v2Acceptances[inviteId]) {
            delete pending2v2Acceptances[inviteId];
        }
        return;
    }

    if (accept) {
        if (originalInvite.gameType === '1v1' || originalInvite.gameType === '1v1_midgame') {
            const newGameId = uuidv4();

            const parsedInitialBoard = originalInvite.initialBoard;
            const newBoard = (originalInvite.gameType === '1v1_midgame' && parsedInitialBoard)
              ? parsedInitialBoard
              : generateBoard();

            const initialScores = originalInvite.initialScores || { 1: 0, 2: 0 };

            const inviterIsP1 = originalInvite.myColor !== 'blue';
            const p1User = inviterIsP1 ? inviterPlayer : respondingPlayer;
            const p2User = inviterIsP1 ? respondingPlayer : inviterPlayer;

            const gamePlayers = [
              { userId: p1User.userId, name: p1User.name, number: 1, socketId: userSocketMap[p1User.userId], team: 1 },
              { userId: p2User.userId, name: p2User.name, number: 2, socketId: userSocketMap[p2User.userId], team: 2 },
            ];

            const isMidgame = originalInvite.gameType === '1v1_midgame';

            const game = {
              gameId: newGameId,
              gameType: '1v1',
              isMidgame: isMidgame, // Explicit boolean flag
              board: newBoard,
              players: gamePlayers,
              turn: originalInvite.turn || 1,
              scores: initialScores,
              bombsUsed: originalInvite.bombsUsed || { 1: false, 2: false },
              screenshot: originalInvite.screenshot || null,
              gameOver: checkGameOver(initialScores),
              lastClickedTile: { 1: null, 2: null },
              messages: [],
              observers: [],
              moves: isMidgame ? [{ type: 'setup', timestamp: Date.now() }] : [] // Seed moves so safe-first-click is bypassed
            };

            games[newGameId] = game;
            gamePlayers.forEach(p => userGameMap[p.userId] = { gameId: newGameId, role: 'player' });

            const serializedBoard = JSON.stringify(game.board);
            await db.collection(GAMES_COLLECTION_PATH).doc(newGameId).set({
              gameId: game.gameId,
              gameType: game.gameType,
              board: serializedBoard,
              player1_userId: p1User.userId, player1_name: p1User.name,
              player2_userId: p2User.userId, player2_name: p2User.name,
              turn: game.turn,
              scores: game.scores,
              bombsUsed: game.bombsUsed,
              screenshot: game.screenshot,
              gameOver: game.gameOver,
              status: 'active',
              lastUpdated: Timestamp.now()
            }, { merge: true });

            clearAllRelatedInvitesForUsers([inviterPlayer.userId, respondingPlayer.userId], inviteId);

            gamePlayers.forEach(p => {
              if (p.socketId) {
                io.sockets.sockets.get(p.socketId)?.join(newGameId);
                io.to(p.socketId).emit("game-start", {
                  gameId: game.gameId,
                  gameType: game.gameType,
                  playerNumber: p.number,
                  board: serializedBoard,
                  turn: game.turn,
                  scores: game.scores,
                  bombsUsed: game.bombsUsed,
                  screenshot: game.screenshot,
                  gameOver: game.gameOver,
                  lastClickedTile: game.lastClickedTile,
                  opponentName: p.number === 1 ? p2User.name : p1User.name,
                  gameChat: game.messages,
                  observers: game.observers,
                  player1Name: p1User.name,
                  player2Name: p2User.name
                });
              }
            });

            emitLobbyPlayersList();
        } else if (originalInvite.gameType === '2v2') {
            if (pending2v2Acceptances[inviteId]) {
                pending2v2Acceptances[inviteId].acceptedUsers.add(respondingUserId);
            } else {
                return;
            }

            const current2v2Acceptance = pending2v2Acceptances[inviteId];
            const allRequiredPlayers = Array.from(current2v2Acceptance.requiredPlayers);

            const allAccepted = allRequiredPlayers.every(userId => current2v2Acceptance.acceptedUsers.has(userId));
            const allPlayersOnlineAndAvailable = allRequiredPlayers.every(userId => {
                const playerInLobby = players.find(p => p.userId === userId);
                return playerInLobby && userSocketMap[userId] && !userGameMap[userId];
            });

            if (allAccepted && allPlayersOnlineAndAvailable) {
                const gameId = uuidv4();
                const newBoard = generateBoard();
                const scores = { 1: 0, 2: 0 };
                const bombsUsed = { 1: false, 2: false };
                const turn = 1;
                const gameOver = false;
                const lastClickedTile = { 1: null, 2: null, 3: null, 4: null };

                const inviter = players.find(p => p.userId === current2v2Acceptance.inviterId);
                const actualInvitees = originalInvite.invitedPlayersInfo.filter(info => allRequiredPlayers.includes(info.userId));
                const allFourPlayerObjects = [inviter, ...actualInvitees.map(info => players.find(p => p.userId === info.userId))].filter(Boolean);
                allFourPlayerObjects.sort((a, b) => a.userId.localeCompare(b.userId));

                const gamePlayers = [
                    { userId: allFourPlayerObjects[0].userId, name: allFourPlayerObjects[0].name, number: 1, socketId: userSocketMap[allFourPlayerObjects[0].userId], team: 1 },
                    { userId: allFourPlayerObjects[1].userId, name: allFourPlayerObjects[1].name, number: 2, socketId: userSocketMap[allFourPlayerObjects[1].userId], team: 1 },
                    { userId: allFourPlayerObjects[2].userId, name: allFourPlayerObjects[2].name, number: 3, socketId: userSocketMap[allFourPlayerObjects[2].userId], team: 2 },
                    { userId: allFourPlayerObjects[3].userId, name: allFourPlayerObjects[3].name, number: 4, socketId: userSocketMap[allFourPlayerObjects[3].userId], team: 2 },
                ];

                const game = {
                    gameId,
                    gameType: '2v2',
                    board: newBoard,
                    players: gamePlayers,
                    turn,
                    scores,
                    bombsUsed,
                    gameOver,
                    lastClickedTile,
                    messages: [],
                    observers: [],
                    moves: []
                };
                games[gameId] = game;

                gamePlayers.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });

                gamePlayers.forEach(p => {
                    if (p.socketId) {
                        io.sockets.sockets.get(p.socketId)?.join(gameId);
                    }
                });

                try {
                    const serializedBoard = JSON.stringify(game.board);
                    await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                        gameId: game.gameId,
                        gameType: game.gameType,
                        board: serializedBoard,
                        player1_userId: allFourPlayerObjects[0].userId, player1_name: allFourPlayerObjects[0].name,
                        player2_userId: allFourPlayerObjects[1].userId, player2_name: allFourPlayerObjects[1].name,
                        player3_userId: allFourPlayerObjects[2].userId, player3_name: allFourPlayerObjects[2].name,
                        player4_userId: allFourPlayerObjects[3].userId, player4_name: allFourPlayerObjects[3].name,
                        turn: game.turn,
                        moves: game.moves,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        status: 'active',
                        lastUpdated: Timestamp.now(),
                        winnerId: null, loserId: null,
                        messages: game.messages,
                        observers: game.observers
                    }, { merge: true });
                } catch (error) {
                    console.error("Error saving new 2v2 game to Firestore:", error);
                    delete games[gameId];
                    gamePlayers.forEach(p => delete userGameMap[p.userId]);
                    emitLobbyPlayersList();
                    return;
                }

                clearAllRelatedInvitesForUsers(allRequiredPlayers, inviteId);
                emitLobbyPlayersList();
                socket.emit("request-observable-games");

                gamePlayers.forEach(p => {
                    io.to(p.socketId).emit("game-start", {
                        gameId: game.gameId,
                        gameType: game.gameType,
                        playerNumber: p.number,
                        board: JSON.stringify(game.board),
                        turn: game.turn,
                        scores: game.scores,
                        bombsUsed: game.bombsUsed,
                        gameOver: game.gameOver,
                        lastClickedTile: game.lastClickedTile,
                        opponentName: "N/A",
                        gameChat: game.messages,
                        observers: game.observers,
                        player1Name: allFourPlayerObjects[0].name, player2Name: allFourPlayerObjects[1].name,
                        player3Name: allFourPlayerObjects[2].name, player4Name: allFourPlayerObjects[3].name,
                    });
                });
            } else {
                const waitingForNames = allRequiredPlayers
                    .filter(uid => !current2v2Acceptance.acceptedUsers.has(uid))
                    .map(uid => players.find(p => p.userId === uid)?.name || uid);
                
                io.to(respondingPlayer.id).emit("server-message", { text: `Waiting for ${waitingForNames.join(', ')} to accept.`, isError: false });
                io.to(inviterPlayer.id).emit("server-message", { text: `Waiting for ${waitingForNames.join(', ')} to accept.`, isError: false });
            }
        }
    } else {
        io.to(inviterPlayer.id).emit("invite-rejected", { fromName: respondingPlayer.name });
        if (originalInvite.gameType === '2v2' && Array.isArray(originalInvite.invitedPlayersInfo)) {
            allPlayerUserIdsInInvite.forEach(uid => {
                if (userSocketMap[uid] && uid !== inviterPlayer.userId && uid !== respondingUserId) {
                    io.to(userSocketMap[uid]).emit("invite-rejected", { fromName: inviterPlayer.name, reason: `${respondingPlayer.name} declined the 2v2 game.` });
                }
            });
        }
        if (pending2v2Acceptances[inviteId]) {
            delete pending2v2Acceptances[inviteId];
        }
        emitLobbyPlayersList();
        socket.emit("request-observable-games");
    }
});

  socket.on("request-pending-invites", () => {
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    
    if (userId) {
        socket.emit("update-invites", pendingInvites[userId] || {});
    }
  });


  socket.on("tile-click", async ({ gameId, x, y, clickStartTime }) => {
    const game = games[gameId];
    if (!game || game.gameOver) {
      return;
    }

    const isMidGameSetup = game.isMidgame || Boolean(game.screenshot);

    // Check if any mine or flag has been revealed yet in the game
    const mineRevealed = game.scores[1] > 0 || game.scores[2] > 0 || game.board.some(row => row.some(cell => cell.isMine && cell.revealed));

    // If no mine has been revealed yet, and the player clicks a blank tile (0 adjacent mines, not a mine),
    // restart/regenerate the board layout right then and there.
    if (!isMidGameSetup && !mineRevealed) {
      const clickedTile = game.board[y][x];
      if (clickedTile.adjacentMines === 0 && !clickedTile.isMine) {
        // Regenerate the board
        game.board = generateBoard();
        
        // Reset basic game trackers for a clean restart
        game.scores = { 1: 0, 2: 0 };
        game.turn = 1;
        game.moves = [];
        game.lastClickedTile = {};

        const cachedBoardString = JSON.stringify(game.board);

        // Sync restart to Firestore
        db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
          board: cachedBoardString,
          turn: game.turn,
          scores: game.scores,
          moves: game.moves,
          lastClickedTile: game.lastClickedTile,
          lastUpdated: Timestamp.now()
        }, { merge: true }).catch(error => {
          console.error("Error updating restarted game in Firestore:", error);
        });

        // Broadcast the fresh board to the frontend so players see the reset
        io.to(gameId).emit("board-update", {
          gameId: game.gameId,
          board: cachedBoardString,
          turn: game.turn,
          scores: game.scores,
          bombsUsed: game.bombsUsed,
          gameOver: game.gameOver,
          lastClickedTile: game.lastClickedTile,
          observers: game.observers,
          clickStartTime: clickStartTime
        });

        return; // Return early so the click isn't executed on the new board
      }
    }

    game.clickStartTime = clickStartTime;

    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;

    if (!userId) {
      socket.emit("game-error", "Authentication required to make moves.");
      return;
    }

    const player = game.players.find((p) => p.userId === userId);
    if (!player || player.number !== game.turn) {
      return;
    }

    player.socketId = socket.id;

    const tile = game.board[y][x];
    if (tile.revealed) {
      return;
    }

    game.lastClickedTile = { ...game.lastClickedTile, [player.number]: { x, y } };

    if (tile.isMine) {
      tile.revealed = true;
      tile.owner = player.number;
      tile.ownerTeam = player.team;
      game.scores[player.team]++;

      if (checkGameOver(game.scores)) {
        game.gameOver = true;
        game.players.forEach(p => delete userGameMap[p.userId]);
        emitLobbyPlayersList();
      }
    } else {
      // STANDARD RECURSION ONLY: Never recalculate adjacentMines or modify revealed numbers!
      revealRecursive(game.board, x, y);

      if (game.gameType === '1v1') {
        game.turn = game.turn === 1 ? 2 : 1;
      } else if (game.gameType === '2v2') {
        game.turn = getNext2v2Turn(game.turn);
      }
    }

    if (!game.moves) game.moves = [];
    game.moves.push({
      type: 'click',
      playerNumber: player.number,
      team: player.team,
      x,
      y,
      timestamp: Date.now()
    });

    // NOTE: Removed any asynchronous/delayed board modifications here 
    // to prevent the board from changing a second later.

    const cachedBoardString = JSON.stringify(game.board);

    // Immediate single broadcast - immutable state
    io.to(gameId).emit("board-update", {
      gameId: game.gameId,
      board: cachedBoardString,
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      observers: game.observers,
      clickStartTime: game.clickStartTime
    });

    const newStatus = game.gameOver ? 'completed' : 'active';
    db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
      board: cachedBoardString,
      turn: game.turn,
      scores: game.scores,
      bombsUsed: game.bombsUsed,
      gameOver: game.gameOver,
      lastClickedTile: game.lastClickedTile,
      status: newStatus,
      moves: game.moves,
      lastUpdated: Timestamp.now(),
      winnerTeam: game.gameOver ? (game.scores[1] > game.scores[2] ? 1 : 2) : null,
      loserTeam: game.gameOver ? (game.scores[1] < game.scores[2] ? 1 : 2) : null,
      observers: game.observers.map(o => ({ userId: o.userId, name: o.name }))
    }, { merge: true }).catch(error => {
      console.error("Error updating game in Firestore:", error);
    });
  });

  socket.on("send-game-message", async ({ gameId, message }) => {
    const game = games[gameId];
    if (!game) {
      return;
    }
    
    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const userName = user ? (user.displayName || user.name || 'Anonymous') : 'Anonymous';

    if (!userId) {
        return;
    }

    const isPlayer = game.players.some(p => p.userId === userId);
    const isObserver = game.observers.some(o => o.userId === userId);

    if (!isPlayer && !isObserver) {
        return;
    }

    const timestamp = new Date().toLocaleTimeString();
    const fullMessage = { sender: userName, text: message, timestamp: timestamp };
    game.messages.push(fullMessage);

    io.to(gameId).emit("receive-game-message", fullMessage);

    try {
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
            messages: FieldValue.arrayUnion(fullMessage)
        });
    } catch (error) {
        console.error("Error saving game message to Firestore:", error);
    }
  });

  socket.on("use-bomb", ({ gameId }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    
    const player = game.players.find((p) => p.userId === userId);
    if (!player) {
        socket.emit("game-error", "Authentication required to use a bomb.");
        return;
    }

    const playerTeam = player.team;

    const isPlayersTurn = (game.gameType === '1v1' && player.number === game.turn) || (game.gameType === '2v2' && (game.turn === player.number || game.players.find(p => p.number === game.turn)?.team === playerTeam));

    if (!isPlayersTurn || game.bombsUsed[playerTeam]) {
        if (!isPlayersTurn) {
            io.to(socket.id).emit("bomb-error", "It's not your turn or your team's turn to use the bomb.");
        } else if (game.bombsUsed[playerTeam]) {
            io.to(socket.id).emit("bomb-error", "Your team has already used its bomb!");
        }
        return;
    }

    const opponentTeam = playerTeam === 1 ? 2 : 1;
    if (game.scores[playerTeam] >= game.scores[opponentTeam]) {
        io.to(socket.id).emit("bomb-error", "You can only use the bomb when your team is behind in score!");
        return;
    }

    player.socketId = socket.id;

    io.to(player.socketId).emit("wait-bomb-center");
  });

  socket.on("bomb-center", async ({ gameId, x, y }) => {
    const game = games[gameId];
    if (!game || game.gameOver) return;

    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    
    const player = game.players.find((p) => p.userId === userId);
    if (!player) {
        socket.emit("game-error", "Authentication required to place the bomb.");
        return;
    }

    const playerTeam = player.team;

    const isPlayersTurn = (game.gameType === '1v1' && player.number === game.turn) || (game.gameType === '2v2' && (game.turn === player.number || game.players.find(p => p.number === game.turn)?.team === playerTeam));

    if (!isPlayersTurn || game.bombsUsed[playerTeam]) {
        if (!isPlayersTurn) {
            io.to(socket.id).emit("bomb-error", "It's not your turn or your team's turn to place the bomb.");
        } else if (game.bombsUsed[playerTeam]) {
            io.to(socket.id).emit("bomb-error", "Your team has already used its bomb!");
        }
        return;
    }

    player.socketId = socket.id;

    const MIN_COORD = 2;
    const MAX_COORD_X = WIDTH - 3;
    const MAX_COORD_Y = HEIGHT - 3;

    if (x < MIN_COORD || x > MAX_COORD_X || y < MIN_COORD || y > MAX_COORD_Y) {
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
      io.to(player.socketId).emit("bomb-error", "All tiles in the bomb area are already revealed.");
      return;
    }

    game.lastClickedTile = { ...game.lastClickedTile, [player.number]: { x, y } };

    game.bombsUsed[playerTeam] = true;
    revealArea(game.board, x, y, player.number, playerTeam, game.scores);

    if (checkGameOver(game.scores)) {
        game.gameOver = true;
        let winnerTeam = null;
        let loserTeam = null;
        if (game.scores[1] > game.scores[2]) {
            winnerTeam = 1; loserTeam = 2;
        } else if (game.scores[2] > game.scores[1]) {
            winnerTeam = 2; loserTeam = 1;
        }
        try {
            await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
                status: 'completed',
                gameOver: true,
                lastUpdated: Timestamp.now(),
                winnerTeam: winnerTeam,
                loserTeam: loserTeam,
                lastClickedTile: game.lastClickedTile,
            }, { merge: true });
        } catch (error) {
            console.error("Error setting game status to 'completed' on bomb usage:", error);
        }
        game.players.forEach(p => delete userGameMap[p.userId]);
        emitLobbyPlayersList();
    }
    if (game.gameType === '1v1') {
        game.turn = game.turn === 1 ? 2 : 1;
    } else if (game.gameType === '2v2') {
        game.turn = getNext2v2Turn(game.turn);
    }

    if (!game.moves) game.moves = [];
    game.moves.push({
        type: 'bomb',
        playerNumber: player.number,
        team: playerTeam,
        x,
        y,
        timestamp: Date.now()
    });

    try {
        const serializedBoard = JSON.stringify(game.board);
        const newStatus = game.gameOver ? 'completed' : 'active';
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: serializedBoard,
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            moves: game.moves,
            status: newStatus,
            lastUpdated: Timestamp.now(),
            winnerTeam: game.gameOver ? (game.scores[1] > game.scores[2] ? 1 : 2) : null,
            loserTeam: game.gameOver ? (game.scores[1] < game.scores[2] ? 1 : 2) : null,
            observers: game.observers.map(o => ({ userId: o.userId, name: o.name }))
        }, { merge: true });
    } catch (error) {
        console.error("Error updating game in Firestore (bomb-center):", error);
    }

    io.to(gameId).emit("board-update", {
        gameId: game.gameId,
        board: JSON.stringify(game.board),
        turn: game.turn,
        scores: game.scores,
        bombsUsed: game.bombsUsed,
        gameOver: game.gameOver,
        lastClickedTile: game.lastClickedTile,
        observers: game.observers,
        clickStartTime: game.clickStartTime
    });
  });

  socket.on("restart-game", async ({ gameId }) => {
    const game = games[gameId];
    if (!game) return;

    const user = socket.request.session?.passport?.user || socket.request.user || null;
    const userId = user ? (user.id || socket.request.user?.id) : null;
    const requestingPlayer = game.players.find(p => p.userId === userId);
    if (!requestingPlayer) return;

    game.board = generateBoard();
    game.scores = { 1: 0, 2: 0 };
    game.bombsUsed = { 1: false, 2: false };
    game.turn = 1;
    game.gameOver = false;
    game.lastClickedTile = {};
    game.messages = [];

    game.players.forEach(p => userGameMap[p.userId] = { gameId, role: 'player' });
    game.observers.forEach(o => userGameMap[o.userId] = { gameId, role: 'observer' });
    emitLobbyPlayersList();

    try {
        const serializedBoard = JSON.stringify(game.board);
        await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            board: serializedBoard,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            turn: game.turn,
            moves: game.moves,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            status: 'active',
            lastUpdated: Timestamp.now(),
            winnerTeam: null,
            loserTeam: null,
            messages: game.messages,
            observers: game.observers.map(o => ({ userId: o.userId, name: o.name }))
        }, { merge: true });
    } catch (error) {
        console.error("Error restarting game in Firestore:", error);
    }

    game.players.forEach(p => {
        io.to(p.socketId).emit("game-restarted", {
            gameId: game.gameId,
            gameType: game.gameType,
            playerNumber: p.number,
            board: JSON.stringify(game.board),
            turn: game.turn,
            scores: game.scores,
            bombsUsed: game.bombsUsed,
            gameOver: game.gameOver,
            lastClickedTile: game.lastClickedTile,
            opponentName: game.gameType === '1v1' ? game.players.find(op => op.userId !== p.userId)?.name : "N/A",
            gameChat: game.messages,
            observers: game.observers,
            player1Name: game.players.find(pl => pl.number === 1)?.name,
            player2Name: game.players.find(pl => pl.number === 2)?.name,
            player3Name: game.players.find(pl => pl.number === 3)?.name,
            player4Name: game.players.find(pl => pl.number === 4)?.name,
        });
    });
  });

socket.on("leave-game", async ({ gameId }) => {
  const game = games[gameId];
  
  const user = socket.request.session?.passport?.user || socket.request.user || null;
  const userId = user ? (user.id || socket.request.user?.id) : null;
  const userName = user ? (user.displayName || user.name || 'Unknown User') : 'Unknown User';

  if (game && userId) {
    const gameMapping = userGameMap[userId];
    if (!gameMapping || gameMapping.gameId !== gameId) {
        return;
    }

    delete userGameMap[userId];
    socket.leave(gameId);

    if (gameMapping.role === 'player') {
      const playerInGame = game.players.find(p => p.userId === userId);
      if (playerInGame) {
        playerInGame.socketId = null;

        game.players.filter(p => p.userId !== userId && p.socketId).forEach(player => {
            io.to(player.socketId).emit("opponent-left");
        });
        io.to(gameId).emit("player-left", { name: playerInGame.name, userId: playerInGame.userId, role: 'player' });

        try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
              status: 'waiting_for_resume',
              lastUpdated: Timestamp.now()
          }, { merge: true });
        } catch (error) {
          console.error("Error updating game status to 'waiting_for_resume' on player leave:", error);
        }
      }
    } else if (gameMapping.role === 'observer') {
      game.observers = game.observers.filter(o => o.userId !== userId);

      try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).update({
              observers: FieldValue.arrayRemove({ userId, name: userName })
          });
      } catch (error) {
          console.error("Error removing observer from Firestore on leave:", error);
      }
      io.to(gameId).emit("observer-left", { name: userName, userId: userId });
    }
  }

  if (userId && !userGameMap[userId]) {
      let existingPlayerInLobby = players.find(p => p.userId === userId);
      if (existingPlayerInLobby) {
          existingPlayerInLobby.id = socket.id;
      } else {
          const userNameForLobby = user ? (user.displayName || user.name) : `User_${userId.substring(0, 8)}`;
          players.push({ id: socket.id, userId: userId, name: userNameForLobby });
      }
  }
  emitLobbyPlayersList();
  socket.emit("request-observable-games");
});


socket.on("disconnect", async () => {
  const user = socket.request.session?.passport?.user || socket.request.user || null;
  const disconnectedUserId = user ? (user.id || socket.request.user?.id) : null;
  const disconnectedUserName = user ? (user.displayName || user.name || 'Unknown User') : 'Unknown User';

  if (disconnectedUserId) {
    delete userSocketMap[disconnectedUserId];
  }

  players = players.filter(p => userSocketMap[p.userId] !== undefined);
  emitLobbyPlayersList();

  let gameId = null;
  let role = null;
  for (const uid in userGameMap) {
      if (uid === disconnectedUserId) {
          gameId = userGameMap[uid].gameId;
          role = userGameMap[uid].role;
          break;
      }
  }

  if (gameId) {
    const game = games[gameId];

    if (game) {
      if (role === 'player') {
        const disconnectedPlayerInGame = game.players.find(p => p.userId === disconnectedUserId);
        if (disconnectedPlayerInGame) {
          disconnectedPlayerInGame.socketId = null;
        }

        try {
          await db.collection(GAMES_COLLECTION_PATH).doc(gameId).set({
            status: 'waiting_for_resume',
            lastUpdated: Timestamp.now()
          }, { merge: true });
        } catch (error) {
          console.error("[Disconnect] Error updating game status to 'waiting_for_resume' on disconnect:", error);
        }

        game.players.filter(p => p.userId !== disconnectedUserId && p.socketId).forEach(player => {
            io.to(player.socketId).emit("opponent-left");
        });
        io.to(gameId).emit("player-left", { name: disconnectedUserName, userId: disconnectedUserId, role: 'player' });

      } else if (role === 'observer') {
        const disconnectedObserverInGame = game.observers.find(o => o.userId === disconnectedUserId);
        if (disconnectedObserverInGame) {
            disconnectedObserverInGame.socketId = null;
        }

        io.to(gameId).emit("observer-left", { name: disconnectedUserName, userId: disconnectedUserId, role: 'observer' });
      }
      socket.emit("request-observable-games");
    } else {
      delete userGameMap[disconnectedUserId];
    }
  }
});

});

app.get("/api/finished-games", async (req, res) => {
  try {
    const finishedSnapshot = await db.collection(GAMES_COLLECTION_PATH)
      .where("status", "==", "completed")
      .get();

    const finishedGames = [];
    finishedSnapshot.forEach((doc) => {
      const data = doc.data();
      finishedGames.push({
        gameId: data.gameId || doc.id,
        gameType: data.gameType || "1v1",
        player1Name: data.player1_name || data.player1Name || "Player 1",
        player2Name: data.player2_name || data.player2Name || "Player 2",
        player3Name: data.player3_name || data.player3Name || null,
        player4Name: data.player4_name || data.player4Name || null,
        scores: data.scores || { 1: 0, 2: 0 },
        winnerTeam: data.winnerTeam !== undefined ? data.winnerTeam : null,
        lastUpdated: data.lastUpdated ? (data.lastUpdated.toDate ? data.lastUpdated.toDate() : data.lastUpdated) : new Date()
      });
    });

    finishedGames.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

    res.json(finishedGames);
  } catch (error) {
    console.error("Error fetching finished games:", error);
    res.status(500).json({ error: "Failed to fetch finished games." });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
