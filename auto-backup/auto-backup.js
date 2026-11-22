/**
 * Gear Locker auto-backup to a folder (Phase 0 of sync).
 *
 * Saves the locker as a normal Gear Locker backup file into a folder the user
 * picks, e.g. a folder inside iCloud Drive, Dropbox or OneDrive. The cloud app
 * on the computer then copies it off the machine. No server, no cost.
 *
 * Uses the File System Access API: Chrome, Edge, Opera, Brave on desktop.
 * Not available in Safari, Firefox or on Android; isSupported() reports that
 * and the UI falls back to export reminders.
 *
 * Files written (one set per device, so two computers sharing one cloud
 * folder never overwrite each other):
 *   gear-locker_<device>_latest.json      always the newest copy
 *   gear-locker_<device>_YYYY-MM-DD.json  one per day, oldest pruned
 *
 * The file format is the app's own backup format (format "gear-locker",
 * formatVersion 2), so the existing "Restore from backup" button reads it.
 *
 * No dependencies. ES module.
 */

const META_DB = 'gear-locker-autobackup';
const META_STORE = 'kv';
const LOCK_NAME = 'gear-locker-autobackup';
const APP_STORES = ['gear', 'panels', 'patches', 'sessions', 'service', 'boards', 'photos', 'meta'];
const DEFAULT_SETTINGS = { ownerName: '', ownerEmail: '', policyNumber: '', insurer: '', currency: 'USD' };

/* ------------------------------------------------------------------ */
/* Feature detection                                                   */
/* ------------------------------------------------------------------ */

export function isSupported() {
  try {
    return typeof window !== 'undefined'
      && window.isSecureContext === true
      && typeof window.showDirectoryPicker === 'function'
      && typeof FileSystemHandle !== 'undefined'
      && 'queryPermission' in FileSystemHandle.prototype;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Small key-value store for the folder handle and backup metadata.    */
/* Kept in its own database so the app's "gear-locker" schema and      */
/* version are never touched.                                          */
/* ------------------------------------------------------------------ */

let metaDbPromise = null;
function metaDb() {
  if (!metaDbPromise) {
    metaDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(META_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(META_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return metaDbPromise;
}
async function kvGet(key) {
  const db = await metaDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvSet(key, value) {
  const db = await metaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function kvDelete(key) {
  const db = await metaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ------------------------------------------------------------------ */
/* Fallback exporter: reads the app's IndexedDB directly and builds    */
/* the same shape as the app's own export. Prefer passing the app's    */
/* export function as `exportLocker` so normalisation stays in one     */
/* place.                                                              */
/* ------------------------------------------------------------------ */

async function databaseExists(name) {
  if (typeof indexedDB.databases !== 'function') return true;
  const list = await indexedDB.databases();
  return list.some((d) => d.name === name);
}

export async function readLockerFromIndexedDB(dbName = 'gear-locker', generator = 'gear-locker-web/auto-backup') {
  if (!(await databaseExists(dbName))) {
    throw new Error('No locker found in this browser yet.');
  }
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName); // no version: never triggers an upgrade
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    const present = APP_STORES.filter((s) => db.objectStoreNames.contains(s));
    const tx = db.transaction(present, 'readonly');
    const all = await Promise.all(present.map((s) => new Promise((resolve, reject) => {
      const req = tx.objectStore(s).getAll();
      req.onsuccess = () => resolve([s, req.result]);
      req.onerror = () => reject(req.error);
    })));
    const data = Object.fromEntries(all);
    const settings = (data.meta || []).find((m) => m.key === 'settings')?.value ?? DEFAULT_SETTINGS;
    const backup = {
      format: 'gear-locker',
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      generator,
      gear: data.gear || [],
      panels: data.panels || [],
      patches: data.patches || [],
      service: data.service || [],
      boards: data.boards || [],
      photos: data.photos || [],
      settings,
    };
    if (data.sessions && data.sessions.length) backup.sessions = data.sessions;
    return JSON.stringify(backup);
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || 'this-computer';
}

function guessDeviceName() {
  const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
  if (p.includes('mac')) return 'Mac';
  if (p.includes('win')) return 'Windows PC';
  if (p.includes('linux') || p.includes('cros')) return 'Linux PC';
  return 'This computer';
}

/** Ignore exportedAt so an unchanged locker is not rewritten every time. */
function stripVolatile(json) {
  return json.replace(/"exportedAt"\s*:\s*"[^"]*"/, '"exportedAt":""');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function writeTextFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); // writes to a swap file; replaces atomically on close
  try {
    await w.write(new Blob([text], { type: 'application/json' }));
    await w.close();
  } catch (err) {
    try { await w.abort(); } catch { /* ignore */ }
    throw err;
  }
}

function friendlyError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Gear Locker no longer has permission to save to that folder. Choose it again to continue.';
  if (name === 'NotFoundError') return 'The backup folder was moved or deleted. Choose a folder again.';
  if (name === 'QuotaExceededError') return 'The disk is full, so the backup could not be saved. Free up space and try again.';
  if (name === 'NoModificationAllowedError' || name === 'InvalidStateError') return 'Another app is using the backup file. Gear Locker will try again shortly.';
  return (err && err.message) || 'The backup could not be saved.';
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object}   [opts]
 * @param {() => Promise<string>} [opts.exportLocker]  Returns the backup JSON. Pass the app's own export function.
 * @param {string}   [opts.dbName='gear-locker']       Used only by the fallback exporter.
 * @param {number}   [opts.keepDays=14]                Daily copies to keep per device.
 * @param {number}   [opts.intervalMinutes=10]         Background check interval while the tab is open.
 * @param {number}   [opts.debounceSeconds=15]         Delay after notifyChange() before saving.
 * @param {() => Promise<FileSystemDirectoryHandle>} [opts.pickDirectory]  Override for tests.
 */
export function createAutoBackup(opts = {}) {
  const cfg = {
    dbName: 'gear-locker',
    keepDays: 14,
    intervalMinutes: 10,
    debounceSeconds: 15,
    generator: 'gear-locker-web/auto-backup',
    ...opts,
  };
  const exportLocker = cfg.exportLocker || (() => readLockerFromIndexedDB(cfg.dbName, cfg.generator));
  const pickDirectory = cfg.pickDirectory || (() => window.showDirectoryPicker({
    id: 'gear-locker-backups', mode: 'readwrite', startIn: 'documents',
  }));

  let dir = null;
  let meta = { deviceName: guessDeviceName(), lastBackupAt: null, lastDigest: null, lastBytes: 0 };
  let state = {
    supported: !!cfg.pickDirectory || isSupported(),
    status: 'loading', // loading | unsupported | off | needs-permission | saving | saved | error
    folderName: null,
    deviceName: meta.deviceName,
    lastBackupAt: null,
    lastBytes: 0,
    error: null,
  };
  const listeners = new Set();
  let running = null;
  let debounceTimer = null;
  let intervalTimer = null;
  let started = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => { try { fn(state); } catch { /* ignore */ } });
  };
  const prefix = () => `gear-locker_${slugify(meta.deviceName)}_`;
  const latestName = () => `${prefix()}latest.json`;
  const dailyName = (d) => `${prefix()}${d}.json`;

  async function saveMeta() { await kvSet('meta', meta); }

  async function permission(request = false) {
    if (!dir) return null;
    const o = { mode: 'readwrite' };
    let p = await dir.queryPermission(o);
    if (p !== 'granted' && request) p = await dir.requestPermission(o);
    return p;
  }

  async function withLock(fn) {
    if (navigator.locks?.request) {
      return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? fn() : 'busy'));
    }
    return fn();
  }

  async function prune() {
    const re = new RegExp(`^${prefix().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{4}-\\d{2}-\\d{2})\\.json$`);
    const dated = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && re.test(name)) dated.push(name);
    }
    dated.sort().reverse();
    for (const name of dated.slice(cfg.keepDays)) {
      await dir.removeEntry(name);
    }
  }

  async function doBackup({ force = false } = {}) {
    if (!dir) return 'off';
    const p = await permission(false);
    if (p !== 'granted') { set({ status: 'needs-permission' }); return 'needs-permission'; }
    return withLock(async () => {
      set({ status: 'saving', error: null });
      try {
        const json = await exportLocker();
        const digest = await sha256(stripVolatile(json));
        const today = dailyName(localDate());
        let todayExists = true;
        try { await dir.getFileHandle(today); } catch { todayExists = false; }
        if (!force && digest === meta.lastDigest && todayExists) {
          set({ status: 'saved' });
          return 'unchanged';
        }
        await writeTextFile(dir, latestName(), json);
        await writeTextFile(dir, today, json);
        await prune();
        meta = { ...meta, lastDigest: digest, lastBackupAt: new Date().toISOString(), lastBytes: json.length };
        await saveMeta();
        set({ status: 'saved', lastBackupAt: meta.lastBackupAt, lastBytes: meta.lastBytes });
        return 'saved';
      } catch (err) {
        const needsFolder = err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError');
        set({ status: needsFolder ? 'needs-permission' : 'error', error: friendlyError(err) });
        return 'error';
      }
    });
  }

  /** Runs one backup at a time; extra calls while one runs share its result. */
  function backup(o) {
    if (!running) running = doBackup(o).finally(() => { running = null; });
    return running;
  }

  const onHidden = () => { if (document.visibilityState === 'hidden') backup(); };
  const onPageHide = () => backup();

  function attach() {
    if (intervalTimer) return;
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    intervalTimer = setInterval(() => {
      if (document.visibilityState === 'visible') backup();
    }, cfg.intervalMinutes * 60 * 1000);
  }
  function detach() {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
    clearInterval(intervalTimer);
    intervalTimer = null;
    clearTimeout(debounceTimer);
  }

  const api = {
    getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Load the saved folder and start watching. Safe to call on every app start. */
    async start() {
      if (started) return state;
      started = true;
      try {
        const saved = await kvGet('meta');
        if (saved) meta = { ...meta, ...saved };
        set({ deviceName: meta.deviceName, lastBackupAt: meta.lastBackupAt, lastBytes: meta.lastBytes });
        if (!state.supported) { set({ status: 'unsupported' }); return state; }
        dir = (await kvGet('dir')) || null;
        if (!dir) { set({ status: 'off' }); return state; }
        set({ folderName: dir.name });
        const p = await permission(false);
        if (p === 'granted') {
          set({ status: 'saved' });
          attach();
          backup();
        } else {
          // Browsers usually ask again after a restart. Needs a click to resume.
          set({ status: 'needs-permission' });
          attach();
        }
      } catch (err) {
        set({ status: 'error', error: friendlyError(err) });
      }
      return state;
    },

    /** Must be called from a click. Opens the folder picker, then backs up. */
    async chooseFolder() {
      let handle;
      try {
        handle = await pickDirectory();
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        set({ status: 'error', error: friendlyError(err) });
        return 'error';
      }
      dir = handle;
      await kvSet('dir', dir);
      set({ folderName: dir.name });
      const p = await permission(true);
      if (p !== 'granted') { set({ status: 'needs-permission' }); return 'needs-permission'; }
      attach();
      return backup({ force: true });
    },

    /** Must be called from a click. Re-grants access after a browser restart. */
    async resume() {
      if (!dir) return api.chooseFolder();
      try {
        const p = await permission(true);
        if (p !== 'granted') { set({ status: 'needs-permission' }); return 'needs-permission'; }
      } catch (err) {
        set({ status: 'needs-permission', error: friendlyError(err) });
        return 'error';
      }
      attach();
      return backup({ force: true });
    },

    backupNow: () => backup({ force: true }),

    /** Call after the app saves anything. Backs up shortly after edits settle. */
    notifyChange() {
      if (!dir) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => backup(), cfg.debounceSeconds * 1000);
    },

    async setDeviceName(name) {
      const clean = String(name || '').trim().slice(0, 40) || guessDeviceName();
      if (clean === meta.deviceName) return;
      meta = { ...meta, deviceName: clean, lastDigest: null };
      await saveMeta();
      set({ deviceName: clean });
      if (dir) backup({ force: true });
    },

    /** Stops backing up. Leaves files already in the folder alone. */
    async turnOff() {
      detach();
      dir = null;
      await kvDelete('dir');
      meta = { ...meta, lastDigest: null };
      await saveMeta();
      set({ status: state.supported ? 'off' : 'unsupported', folderName: null, error: null });
    },

    /** Lists this device's backups in the folder, newest first. */
    async listBackups() {
      if (!dir || (await permission(false)) !== 'granted') return [];
      const out = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file' || !name.startsWith('gear-locker_') || !name.endsWith('.json')) continue;
        const f = await handle.getFile();
        out.push({ name, size: f.size, modified: f.lastModified, mine: name.startsWith(prefix()) });
      }
      return out.sort((a, b) => b.modified - a.modified);
    },

    /** Returns the text of a backup file, for the app's restore function. */
    async readBackup(name = latestName()) {
      if (!dir) throw new Error('No backup folder chosen.');
      const fh = await dir.getFileHandle(name);
      return (await fh.getFile()).text();
    },

    stop() { detach(); },
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Export reminders for browsers without folder access                 */
/* ------------------------------------------------------------------ */

const REMINDER_KEY = 'gear-locker-last-manual-export';

export function markManualExport(date = new Date()) {
  try { localStorage.setItem(REMINDER_KEY, date.toISOString()); } catch { /* ignore */ }
}

export function daysSinceManualExport(now = new Date()) {
  try {
    const v = localStorage.getItem(REMINDER_KEY);
    if (!v) return null;
    return Math.floor((now - new Date(v)) / 86400000);
  } catch {
    return null;
  }
}
