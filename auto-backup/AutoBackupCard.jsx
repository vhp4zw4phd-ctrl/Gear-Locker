// Drop-in card for the app's "Backup & restore" screen (More → Backup & restore).
// Uses the app's existing class names: card, btn, row, wrap, small, muted.
//
//   import { createAutoBackup } from './auto-backup.js';
//   export const autoBackup = createAutoBackup({ exportLocker: exportBackupJson });
//   autoBackup.start();
//
//   <AutoBackupCard controller={autoBackup} onRestore={restoreFromJsonText} />

import { useEffect, useState, useSyncExternalStore } from 'react';
import { daysSinceManualExport } from './auto-backup.js';

const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};
const size = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export default function AutoBackupCard({ controller, onRestore, reminderDays = 7 }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getState);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]);
  const [name, setName] = useState(s.deviceName);

  useEffect(() => { setName(s.deviceName); }, [s.deviceName]);
  useEffect(() => {
    if (s.status === 'saved') controller.listBackups().then(setFiles).catch(() => setFiles([]));
  }, [s.status, s.lastBackupAt, controller]);

  const run = (fn) => async () => { setBusy(true); try { await fn(); } finally { setBusy(false); } };

  if (s.status === 'loading') return null;

  if (s.status === 'unsupported') {
    const d = daysSinceManualExport();
    const due = d === null || d >= reminderDays;
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Automatic backup</h3>
        <p className="small muted">
          This browser can’t save to a folder automatically. Safari, Firefox and phones don’t support it yet.
          Use Chrome or Edge on a computer for automatic backups, or export a backup regularly.
        </p>
        {due && (
          <p className="small" role="status">
            {d === null ? 'You haven’t exported a backup from this browser yet.' : `Your last export was ${d} days ago.`}
          </p>
        )}
      </div>
    );
  }

  const stale = s.lastBackupAt && Date.now() - new Date(s.lastBackupAt).getTime() > reminderDays * 86400000;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Automatic backup</h3>

      {s.status === 'off' && (
        <>
          <p className="small muted">
            Save a copy of your locker to a folder on this computer every time it changes.
            Pick a folder inside iCloud Drive, Dropbox or OneDrive and your backups leave this machine too.
          </p>
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={run(controller.chooseFolder)}>Choose backup folder</button>
          </div>
        </>
      )}

      {s.status === 'needs-permission' && (
        <>
          <p className="small" role="status">
            Automatic backup is paused. Your browser needs your OK to keep saving to{' '}
            <strong>{s.folderName || 'your backup folder'}</strong>.
          </p>
          {s.error && <p className="small muted">{s.error}</p>}
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={run(controller.resume)}>Resume backups</button>
            <button className="btn" disabled={busy} onClick={run(controller.chooseFolder)}>Choose a different folder</button>
          </div>
        </>
      )}

      {(s.status === 'saved' || s.status === 'saving' || s.status === 'error') && (
        <>
          <p className="small" role="status">
            {s.status === 'saving' && 'Saving backup…'}
            {s.status === 'saved' && <>Saving to <strong>{s.folderName}</strong>. Last backup {ago(s.lastBackupAt)}{s.lastBytes ? `, ${size(s.lastBytes)}` : ''}.</>}
            {s.status === 'error' && s.error}
          </p>
          {stale && s.status === 'saved' && (
            <p className="small">Your last backup is more than {reminderDays} days old. Open Gear Locker in this browser and it saves a fresh one.</p>
          )}
          <div className="row wrap">
            <button className="btn" disabled={busy || s.status === 'saving'} onClick={run(controller.backupNow)}>Back up now</button>
            {onRestore && (
              <button
                className="btn"
                disabled={busy}
                onClick={run(async () => onRestore(await controller.readBackup()))}
              >
                Restore latest from folder
              </button>
            )}
            <button className="btn" disabled={busy} onClick={run(controller.turnOff)}>Turn off</button>
          </div>

          <label className="small muted" htmlFor="ab-device" style={{ display: 'block', marginTop: 12 }}>
            This computer’s name in backup file names
          </label>
          <input
            id="ab-device"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => controller.setDeviceName(name)}
          />

          {files.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="small">Backups in this folder ({files.length})</summary>
              <ul className="small muted">
                {files.map((f) => (
                  <li key={f.name}>{f.name} · {size(f.size)} · {new Date(f.modified).toLocaleString()}{f.mine ? '' : ' · other device'}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
