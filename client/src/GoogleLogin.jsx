// GoogleLogin.jsx - This file is no longer directly imported into App.jsx.
// The logic for initiating Google login is now handled directly within App.jsx's handleLogin function.
// This file can be removed or kept as a reference if you prefer to encapsulate login buttons.
// If you keep it, ensure it's in the same src directory as App.jsx.

import React from 'react';

const GoogleLogin = ({ onLogin }) => { // Accepts onLogin prop
  const handleLoginClick = () => {
    // This URL should point to your backend's Google authentication endpoint.
    window.location.href = 'https://minesweeper-flags-backend.onrender.com/auth/google';
  };

  return (
    <button onClick={handleLoginClick} className="google-login-button">
      <svg className="google-icon w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12.24 10.285V14.4h6.88c-.28 1.48-1.59 4.31-6.88 4.31-4.14 0-7.5-3.36-7.5-7.5s3.36-7.5 7.5-7.5c2.23 0 3.84 0.96 4.79 1.845l3.1-3.1C18.41 1.715 15.82 0 12.24 0 5.46 0 0 5.46 0 12.24s5.46 12.24 12.24 12.24c7.34 0 12.01-5.31 12.01-11.96 0-.79-.06-1.46-.17-2.125h-11.84z"/>
      </svg>
      Login with Google
    </button>
  );
};

export default GoogleLogin;
