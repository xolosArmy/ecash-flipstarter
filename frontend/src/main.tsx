import React from 'react';
import ReactDOM from 'react-dom/client';
import { Buffer } from 'buffer';
import { App } from './App';
import './styles/teyolia.css';

if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
