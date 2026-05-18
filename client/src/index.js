/**
 * Index
 * Точка входа React приложения
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/architectui-overrides.css';
import { installNavigationClickPointerTracking } from './utils/navigationClick.js';

installNavigationClickPointerTracking();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

