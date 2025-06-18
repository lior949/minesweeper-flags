// GoogleLogin.jsx (or a new AuthButtons.jsx)
import React, { useEffect, useState } from "react";
import axios from "axios";

axios.defaults.withCredentials = true;

function GoogleLogin({ onLogin }) { // Consider renaming this component
  const [user, setUser] = useState(null);

  const fetchUser = async () => {
    try {
      const res = await axios.get("https://minesweeper-flags-backend.onrender.com/me");
      setUser(res.data.user);
      onLogin(res.data.user.displayName); // Send name to parent
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  const handleGoogleLogin = () => { // Renamed for clarity
    window.location.href = "https://minesweeper-flags-backend.onrender.com/auth/google";
  };

  const handleFacebookLogin = () => { // <--- NEW HANDLER
    window.location.href = "https://minesweeper-flags-backend.onrender.com/auth/facebook";
  };

  return (
    <div style={{ textAlign: "center", marginTop: "20px" }}>
      {user ? (
        <div>
          <p>Logged in as <b>{user.displayName}</b></p>
          {/* You might want a logout button here too */}
        </div>
      ) : (
        <>
          <button onClick={handleGoogleLogin} style={{ marginRight: '10px' }}>
            Login with Google
          </button>
          <button onClick={handleFacebookLogin}> {/* <--- NEW BUTTON */}
            Login with Facebook
          </button>
        </>
      )}
    </div>
  );
}

export default GoogleLogin; // Remember to rename if it becomes AuthButtons
