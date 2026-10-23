import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EmailConfirmation } from './components/EmailAccess';
import App from './App';
import { installMotionInput } from './lib/motion-input';
import Invitation from './components/Invitation';
import './index.css';
import './styles/rooms.css';
import './styles/tint.css';
import './styles/automations.css';
import './styles/studio.css';
import './styles/controls.css';
import './styles/drag-surfaces.css';
import './styles/geometry.css';
import './styles/motion.css';
import { applyStudioAppearance } from './lib/appearance';
import { prepareAccount } from './lib/account';
import { installSwReload } from './lib/sw-reload';
import { guardStandaloneEdges } from './lib/standalone-edge';

// Safari exposes this flag only for an iOS app launched from the Home Screen.
const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
document.documentElement.toggleAttribute('data-ios-standalone', iosStandalone);
if (iosStandalone) {
  // Existing installs may still draw under the status bar; use their actual inset.
  const updateInsets = () => document.documentElement.toggleAttribute('data-ios-windowed', parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) === 0);
  updateInsets();
  window.addEventListener('resize', updateInsets);
}

installMotionInput();
installSwReload();
guardStandaloneEdges();
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#signin/')) location.reload();
});

let emailToken = location.hash.startsWith('#signin/') ? location.hash.slice(8) : '';
try {
  if (emailToken) sessionStorage.setItem('todos.emailPending', emailToken);
  else emailToken = sessionStorage.getItem('todos.emailPending') || '';
} catch { /* session storage unavailable */ }
if (emailToken) history.replaceState(null, '', location.pathname + location.search);

void prepareAccount().then(() => {
  applyStudioAppearance();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {emailToken ? <EmailConfirmation token={emailToken} /> : new URL(location.href).searchParams.get('invite') ? <Invitation token={new URL(location.href).searchParams.get('invite')!} /> : <App />}
    </StrictMode>,
  );
});
