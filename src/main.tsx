import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { getWorld, useApp } from './store';
import { cameraProbe } from './scene/Scene';
import { getPark } from './data/parkClient';
import { vehiclePose } from './data/park';
import { parkTime } from './data/parkClient';

// Read-only hook for automated verification: only exposed with ?debug in the URL.
if (new URLSearchParams(window.location.search).has('debug')) {
  (window as unknown as { __cargoverse: unknown }).__cargoverse = { getWorld, state: () => useApp.getState(), camera: cameraProbe, park: getPark, vehiclePose, parkTime };
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
