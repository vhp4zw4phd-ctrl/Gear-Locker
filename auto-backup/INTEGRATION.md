# Auto-backup to a folder: integration

Phase 0 of sync. Saves the locker into a folder the user picks, such as a
folder in iCloud Drive, Dropbox or OneDrive. No server and no cost.

| file                 | what it is                                                        |
|----------------------|-------------------------------------------------------------------|
| `auto-backup.js`     | The module. No dependencies.                                      |
| `AutoBackupCard.jsx` | React card for More → Backup & restore, using the app's class names |
| `demo/index.html`    | Standalone demo with a sample locker in its own database          |
| `test/run.mjs`       | Browser test of the module (23 checks)                            |
| `test/live-restore.cjs` | Restores a module-written file in the live app and reads it back |

## Browser support

Chrome, Edge, Opera and Brave on desktop. Safari, Firefox and Android
browsers don't have the folder API. The card tells those users and falls back
to "export regularly".

## What it writes

```
gear-locker_<device>_latest.json       newest copy, replaced each time
gear-locker_<device>_YYYY-MM-DD.json   one per day, keeps 14
```

`<device>` comes from a name the user can edit ("Studio Mac"), so two
computers saving into the same cloud folder never overwrite each other.

The file is the app's existing backup format (`format: "gear-locker"`,
`formatVersion: 2`). The app's own **Restore from backup** reads it with no
changes. This was checked against the live app: restoring a module-written file
reported "Restored 2 items", and reading the app's database back returned the
same records.

## When it saves

- After the app calls `notifyChange()` (15 s debounce).
- When the tab is hidden or closed.
- Every 10 minutes while the tab is open.
- Only if the locker changed (SHA-256 of the backup, ignoring `exportedAt`),
  or if today's daily file doesn't exist yet.

One backup runs at a time across tabs (`navigator.locks`). Files are written
through `createWritable()`, which saves to a temporary file and swaps it in
on close, so a crash never leaves a half-written backup.

After the browser restarts, Chrome usually asks for permission again. The card
shows "Automatic backup is paused" with a **Resume backups** button. Newer
Chrome versions can offer "Allow on every visit", which removes that step.

## Wiring it into the app (4 steps)

The production source isn't in this repo yet, so these are written against the
app's behaviour as shipped. Names in brackets are what the functions are called
in the minified bundle, to help find them.

1. **Create the controller once**, passing the app's existing export function
   (the one the "Export backup" button calls; `wt` in the bundle). It returns
   the backup JSON string.

   ```js
   // src/autoBackup.js
   import { createAutoBackup } from './auto-backup.js';
   import { exportBackupJson } from './storage'; // the existing export
   export const autoBackup = createAutoBackup({ exportLocker: exportBackupJson });
   ```

   If you skip `exportLocker`, the module reads the `gear-locker` IndexedDB
   itself and builds the same format.

2. **Start it on app load.**

   ```js
   import { autoBackup } from './autoBackup';
   autoBackup.start();
   ```

3. **Call `notifyChange()` after every write.** The app has one put helper and
   one delete helper for IndexedDB (`St` and `Ct` in the bundle) plus the
   restore writer (`Et`). Add one line at the end of each:

   ```js
   autoBackup.notifyChange();
   ```

4. **Add the card** to the Backup & restore screen, above the existing Export
   and Restore buttons. Pass the app's restore function (`Tt`, which takes the
   JSON text) so "Restore latest from folder" uses the same validation and
   confirmation as a manual restore.

   ```jsx
   <AutoBackupCard
     controller={autoBackup}
     onRestore={async (text) => {
       if (!confirm('Restoring replaces everything currently in this locker. Continue?')) return;
       await restoreFromText(text);
       await reload();
     }}
   />
   ```

   Also call `markManualExport()` in the Export backup click handler, so
   Safari and Firefox users get an "export due" reminder after 7 days.

## Privacy

The backup file is not encrypted. That matches the existing manual export.
The license key is not included, same as the manual export. Photos are
included. The landing page should say the file sits in whatever cloud folder
the user picks.

## Run the tests

```bash
NODE_PATH=$(npm root -g) node auto-backup/test/run.mjs
```

```bash
NODE_PATH=$(npm root -g) node auto-backup/test/live-restore.cjs
```

The second one opens gear-locker.com in a headless browser. Everything it
writes stays in that throwaway browser profile.
