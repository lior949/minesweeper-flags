import React, { useState, useEffect } from "react";

export default function ReplaysTable({ onWatchReplay, onBack }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filter States
  const [searchPlayer, setSearchPlayer] = useState("");
  const [filterGameType, setFilterGameType] = useState("all");

  // Sort States
  const [sortField, setSortField] = useState("lastUpdated");
  const [sortOrder, setSortOrder] = useState("desc");

  useEffect(() => {
    fetch("https://minesweeper-flags-backend.onrender.com/api/finished-games")
      .then((res) => res.json())
      .then((data) => {
        setGames(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load finished games:", err);
        setLoading(false);
      });
  }, []);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const processedGames = games
    .filter((game) => {
      const p1 = game.player1Name?.toLowerCase() || "";
      const p2 = game.player2Name?.toLowerCase() || "";
      const p3 = game.player3Name?.toLowerCase() || "";
      const p4 = game.player4Name?.toLowerCase() || "";
      const search = searchPlayer.toLowerCase();

      const matchesPlayer =
        p1.includes(search) || p2.includes(search) || p3.includes(search) || p4.includes(search);
      const matchesType = filterGameType === "all" || game.gameType === filterGameType;

      return matchesPlayer && matchesType;
    })
    .sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (sortField === "lastUpdated") {
        aVal = new Date(aVal).getTime();
        bVal = new Date(bVal).getTime();
      } else if (sortField === "scoreSum") {
        aVal = (a.scores?.[1] || 0) + (a.scores?.[2] || 0);
        bVal = (b.scores?.[1] || 0) + (b.scores?.[2] || 0);
      } else if (typeof aVal === "string") {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1;
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });

  return (
    <div style={{ padding: "24px", maxWidth: "1000px", margin: "0 auto", color: "#f8fafc", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h2>Finished Games & Replay History</h2>
        <button
          className="btn-back-lobby"
          onClick={() => (window.location.pathname = "/")}
        >
          ← Back to Lobby
        </button>
      </div>

      {/* Filter Bar */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "20px", background: "rgba(30, 41, 59, 0.8)", padding: "16px", borderRadius: "8px" }}>
        <input
          type="text"
          placeholder="Filter by player name..."
          value={searchPlayer}
          onChange={(e) => setSearchPlayer(e.target.value)}
          className="message-input"
          style={{ flex: 1 }}
        />
        <select
          value={filterGameType}
          onChange={(e) => setFilterGameType(e.target.value)}
          className="message-input"
          style={{ width: "150px" }}
        >
          <option value="all">All Modes</option>
          <option value="1v1">1v1</option>
          <option value="2v2">2v2</option>
        </select>
      </div>

      {/* Replays Table */}
      {loading ? (
        <p>Loading game history...</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", background: "rgba(30, 41, 59, 0.8)", borderRadius: "8px", overflow: "hidden" }}>
          <thead>
            <tr style={{ background: "#334155", borderBottom: "2px solid #475569", cursor: "pointer" }}>
              <th style={{ padding: "12px" }} onClick={() => handleSort("gameType")}>
                Mode {sortField === "gameType" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
              </th>
              <th style={{ padding: "12px" }} onClick={() => handleSort("player1Name")}>
                Players / Teams {sortField === "player1Name" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
              </th>
              <th style={{ padding: "12px" }} onClick={() => handleSort("scoreSum")}>
                Final Score {sortField === "scoreSum" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
              </th>
              <th style={{ padding: "12px" }} onClick={() => handleSort("lastUpdated")}>
                Date {sortField === "lastUpdated" ? (sortOrder === "asc" ? "▲" : "▼") : ""}
              </th>
              <th style={{ padding: "12px", textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {processedGames.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ padding: "16px", textAlign: "center" }}>No matches found.</td>
              </tr>
            ) : (
              processedGames.map((game) => (
                <tr key={game.gameId} style={{ borderBottom: "1px solid #334155" }}>
                  <td style={{ padding: "12px" }}>{game.gameType}</td>
                  <td style={{ padding: "12px" }}>
                    {game.gameType === "2v2" ? (
                      `Team 1 (${game.player1Name}, ${game.player2Name}) vs Team 2 (${game.player3Name}, ${game.player4Name})`
                    ) : (
                      `${game.player1Name} vs ${game.player2Name}`
                    )}
                  </td>
                  <td style={{ padding: "12px" }}>
                    {game.scores?.[1] || 0} : {game.scores?.[2] || 0}
                  </td>
                  <td style={{ padding: "12px" }}>
                    {new Date(game.lastUpdated).toLocaleString()}
                  </td>
                  <td style={{ padding: "12px", textAlign: "right" }}>
                    <button
                      className="bomb-button"
                      onClick={() => onWatchReplay(game.gameId)}
                    >
                      Watch Replay
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <div style={{ padding: "24px", maxWidth: "1000px", margin: "0 auto", color: "#f8fafc", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", alignItems: "center", marginBottom: "20px" }}>
        <h2>Finished Games & Replay History</h2>
        <button className="btn-back-lobby" onClick={onBack}>
          ← Back to Lobby
        </button>
      </div>
      
      {/* ... filter bar & table JSX ... */}
    </div>
  );
}
