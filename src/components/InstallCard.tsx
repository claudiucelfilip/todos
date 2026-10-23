// §11.10 E: the install offer as a one-time card at the bottom left, from the second visit on.
// Install or × retires it for good; Settings keeps a permanent row.
import { useStore } from '../hooks/useStore';
import { copy } from '../lib/copy';
import { dismissInstall, promptInstall, useInstall, visits } from '../lib/install';

export default function InstallCard() {
  const { readOnly } = useStore();
  const { available, dismissed } = useInstall();
  if (!available || dismissed || readOnly || visits() < 2) return null;
  return (
    <div className="install-card" role="status" data-testid="install-card">
      <span>{copy.installOffer()}</span>
      <button type="button" className="install-card-go" onClick={() => void promptInstall()}>
        Install
      </button>
      <button type="button" className="install-card-x" aria-label="Dismiss" onClick={dismissInstall}>
        ×
      </button>
    </div>
  );
}
