import React, { useEffect, useState } from "react";
import axios from "axios";

axios.defaults.withCredentials = true;

function GoogleLogin({ onLogin }) {
  const [user, setUser] = useState(null);

  const fetchUser = async () => {
    try {
      const res = await axios.get("https://minesweeperflags.com/me");
      setUser(res.data.user);
      onLogin(res.data.user.displayName); // Send name to parent
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const handleLogin = () => {
    window.location.href = "https://minesweeperflags.com/auth/google";
  };

  return (
    <div style={{ textAlign: "center", marginTop: "20px" }}>
      {user ? (
        <div>
          <p>Logged in as <b>{user.displayName}</b></p>
        </div>
      ) : (
        <button onClick={handleLogin}>
          Login with Google
        </button>
      )}
    </div>
  );
}

export default GoogleLogin;
