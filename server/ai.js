/**
 * Minesweeper Flags - AI Engine (Expected Value & Adversary Advantage Minimization)
 * 
 * Rules Context:
 * In this version of Minesweeper, players SCORE points by revealing MINES.
 * Therefore, the AI aims to find and click MINES rather than avoid them.
 * When no deterministic mine can be found, it evaluates expected value and 
 * minimizes adversary advantage (revealing the fewest constraints to the opponent).
 */

function getBestAIMove(board) {
    const height = board.length;
    const width = board[0].length;
    let mineCandidates = [];

    // First pass: Analyze fully constrained cells to find hidden tiles that must be mines (Flag Hunting Mode)
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const tile = board[r][c];
            if (tile.revealed && tile.mineCount > 0) {
                let unrevealedAdjacent = [];
                let flaggedAdjacent = 0;

                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr;
                        const nc = c + dc;
                        if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
                            const adj = board[nr][nc];
                            if (!adj.revealed) {
                                if (adj.flagged) flaggedAdjacent++;
                                else unrevealedAdjacent.push({ r: nr, c: nc });
                            }
                        }
                    }
                }

                // If unrevealed adjacent plus flagged equals mineCount, all remaining unrevealed are definitely mines!
                if ((unrevealedAdjacent.length + flaggedAdjacent) === tile.mineCount && unrevealedAdjacent.length > 0) {
                    unrevealedAdjacent.forEach(coord => {
                        if (!mineCandidates.some(m => m.r === coord.r && m.c === coord.c)) {
                            mineCandidates.push(coord);
                        }
                    });
                }
            }
        }
    }

    // If deterministic mine candidates are found, prioritize them to score points
    if (mineCandidates.length > 0) {
        return mineCandidates[Math.floor(Math.random() * mineCandidates.length)];
    }

    // Advanced Fallback: Expected Value & Adversary Advantage Minimization
    // When no deterministic mines are found, evaluate all unrevealed non-flagged tiles.
    // We evaluate how much deterministic information (subsequent safe openings/mines) 
    // the move leaks to the opponent on their turn.
    let candidateTiles = [];
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            if (!board[r][c].revealed && !board[r][c].flagged) {
                let neighborRevealedCount = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nr = r + dr;
                        const nc = c + dc;
                        if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
                            if (board[nr][nc].revealed) neighborRevealedCount++;
                        }
                    }
                }
                candidateTiles.push({ r, c, exposure: neighborRevealedCount });
            }
        }
    }

    if (candidateTiles.length > 0) {
        // Sort candidates by lowest exposure to adjacent revealed numbers 
        // to minimize giving away clear constraints to the opponent on their turn.
        candidateTiles.sort((a, b) => a.exposure - b.exposure);
        
        // Pick from the lowest exposure tier (minimizing adversary advantage)
        const minExposure = candidateTiles[0].exposure;
        const lowExposureTier = candidateTiles.filter(t => t.exposure === minExposure);
        
        return lowExposureTier[Math.floor(Math.random() * lowExposureTier.length)];
    }

    return null;
}

module.exports = { getBestAIMove };