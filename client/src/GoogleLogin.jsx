// src/GoogleLogin.js
import React from 'react';

const GoogleLogin = () => {
  const handleLoginClick = () => {
    // Redirect the browser to the backend's Google authentication endpoint
    // This will initiate the OAuth flow.
    // The backend will then redirect back to your frontend's AuthCallback URL.
    window.location.href = 'https://minesweeper-flags-backend.onrender.com/auth/google';
  };

  return (
    <button onClick={handleLoginClick} className="google-login-button">
      <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/1024px-Google_%22G%22_logo.svg.png" alt="Google Logo" className="w-6 h-6 mr-3" />
      Login with Google
    </button>
  );
};

export default GoogleLogin;
