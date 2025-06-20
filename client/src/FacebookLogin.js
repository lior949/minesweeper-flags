// src/FacebookLogin.js
import React from 'react';

const FacebookLogin = () => {
  const handleLoginClick = () => {
    // Redirect the browser to the backend's Facebook authentication endpoint.
    // This will initiate the OAuth flow.
    // The backend will then redirect back to your frontend's AuthCallback URL.
    window.location.href = 'https://minesweeper-flags-backend.onrender.com/auth/facebook';
  };

  return (
    <button onClick={handleLoginClick} className="facebook-login-button">
      {/* Font Awesome Facebook icon or inline SVG for consistent styling */}
      <svg className="w-6 h-6 mr-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 12h-1v5h1v-5zm3-2h-1.5a2.5 2.5 0 00-2.5 2.5V17h4V12.5a2.5 2.5 0 00-2.5-2.5zM12 2C6.477 2 2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.873V14.89h-2.54V12h2.54V9.77c0-2.535 1.554-3.926 3.792-3.926 1.095 0 2.19.195 2.19.195V8.5h-1.397c-1.259 0-1.638.775-1.638 1.56V12h2.773l-.443 2.89h-2.33V22h5.532c4.781-.745 8.438-4.882 8.438-9.873C22 6.477 17.523 2 12 2z" />
      </svg>
      Login with Facebook
    </button>
  );
};

export default FacebookLogin;
