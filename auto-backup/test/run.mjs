// Browser test for auto-backup.js.
// Runs the real module in Chromium. The folder picker is replaced by the
// browser's private file system (OPFS), which has the same handle API, because
// a headless browser cannot click through a native folder dialog.
//
//   node auto-backup/test/run.mjs
//
// Requires Playwright with Chromium available.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = req.url === '/blank' ? '<!doctype html><title>t</title>' : await readFile(path);
    res.writeHead(200, { 'content-type': req.url === '/blank' ? 'text/html' : types[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/blank`);

const results = await page.evaluate(async () => {
  const m = await import('/auto-backup.js');
  const out = [];
  const check = (name, ok, info = '') => out.push({ name, ok: !!ok, info: String(info) });

  // Seed a locker shaped like the app's database.
  const DB = 'gear-locker-test';
  const STORES = ['gear', 'panels', 'patches', 'sessions', 'service', 'boards', 'photos', 'meta'];
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { for (const s of STORES) r.result.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const put = async (store, v) => { const db = await open(); await new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = res; }); db.close(); };
  await put('gear', { id: 'g1', make: 'Universal Audio', model: '1176LN' });
  await put('patches', { id: 'p1', gearId: 'g1', name: 'Lead vox' });
  await put('meta', { key: 'settings', value: { ownerName: 'Test', ownerEmail: '', policyNumber: '', insurer: '', currency: 'USD' } });
  await put('meta', { key: 'licence', value: 'SECRET-LICENSE' });

  // 1. Fallback exporter matches the app's backup format.
  const json = await m.readLockerFromIndexedDB(DB);
  const b = JSON.parse(json);
  check('export uses app backup format', b.format === 'gear-locker' && b.formatVersion === 2 && Array.isArray(b.gear) && b.gear.length === 1, `${b.format} v${b.formatVersion}`);
  check('export includes settings', b.settings && b.settings.ownerName === 'Test');
  check('export leaves out the license key', !json.includes('SECRET-LICENSE'));
  check('export omits empty sessions like the app', !('sessions' in b));
  let missing = '';
  try { await m.readLockerFromIndexedDB('does-not-exist'); } catch (e) { missing = e.message; }
  check('missing locker gives a clear error', /No locker found/.test(missing), missing);

  // Folder: a fresh OPFS subdirectory.
  const opfs = await navigator.storage.getDirectory();
  try { await opfs.removeEntry('backups', { recursive: true }); } catch {}
  const folder = await opfs.getDirectoryHandle('backups', { create: true });
  const names = async () => { const n = []; for await (const [k] of folder.entries()) n.push(k); return n.sort(); };
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  const ab = m.createAutoBackup({ dbName: DB, pickDirectory: async () => folder, debounceSeconds: 0.2 });
  await ab.start();
  check('starts off with no folder', ab.getState().status === 'off', ab.getState().status);

  // 2. Choosing a folder writes latest + today.
  await ab.setDeviceName('Studio Mac');
  const r1 = await ab.chooseFolder();
  let files = await names();
  check('first backup saved', r1 === 'saved', r1);
  check('writes latest and daily files', files.includes('gear-locker_studio-mac_latest.json') && files.includes(`gear-locker_studio-mac_${today}.json`), files.join(', '));

  // 3. Unchanged locker is not rewritten.
  const before = (await (await folder.getFileHandle('gear-locker_studio-mac_latest.json')).getFile()).lastModified;
  await new Promise((r) => setTimeout(r, 30));
  const auto = await (async () => { ab.notifyChange(); await new Promise((r) => setTimeout(r, 400)); return (await (await folder.getFileHandle('gear-locker_studio-mac_latest.json')).getFile()).lastModified; })();
  check('unchanged locker is skipped', auto === before, `${before} → ${auto}`);

  // 4. A change is picked up by notifyChange().
  await put('patches', { id: 'p2', gearId: 'g1', name: 'Drum bus smash' });
  ab.notifyChange();
  await new Promise((r) => setTimeout(r, 600));
  const latest = JSON.parse(await ab.readBackup());
  check('change is backed up after notifyChange', latest.patches.length === 2, `patches=${latest.patches.length}`);

  // 5. Pruning keeps 14 daily copies for this device and leaves other files alone.
  for (let i = 1; i <= 20; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const n = `gear-locker_studio-mac_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
    const w = await (await folder.getFileHandle(n, { create: true })).createWritable(); await w.write('{}'); await w.close();
  }
  for (const other of ['gear-locker_macbook_latest.json', 'gear-locker_macbook_2020-01-01.json', 'notes.txt']) {
    const w = await (await folder.getFileHandle(other, { create: true })).createWritable(); await w.write('x'); await w.close();
  }
  await ab.backupNow();
  files = await names();
  const mineDaily = files.filter((f) => /^gear-locker_studio-mac_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  check('keeps 14 daily copies', mineDaily.length === 14, mineDaily.length);
  check('newest daily copy kept', mineDaily.includes(`gear-locker_studio-mac_${today}.json`));
  check('other device files untouched', files.includes('gear-locker_macbook_latest.json') && files.includes('gear-locker_macbook_2020-01-01.json'));
  check('unrelated files untouched', files.includes('notes.txt'));

  // 6. listBackups marks this device's files.
  const list = await ab.listBackups();
  check('listBackups separates devices', list.some((f) => f.mine) && list.some((f) => !f.mine && f.name.includes('macbook')));

  // 7. Folder and settings survive a reload (new controller, same browser).
  ab.stop();
  const ab2 = m.createAutoBackup({ dbName: DB, pickDirectory: async () => folder });
  await ab2.start();
  const s2 = ab2.getState();
  check('remembers folder after reload', s2.status === 'saved' && s2.folderName === 'backups', `${s2.status} ${s2.folderName}`);
  check('remembers device name after reload', s2.deviceName === 'Studio Mac', s2.deviceName);

  // 8. Turning off stops backups but keeps files.
  await ab2.turnOff();
  check('turn off sets status off', ab2.getState().status === 'off');
  check('turn off keeps existing files', (await names()).includes('gear-locker_studio-mac_latest.json'));
  ab2.stop();

  // 9. Cancelling the picker is not an error.
  const ab3 = m.createAutoBackup({ dbName: DB, pickDirectory: async () => { throw new DOMException('cancelled', 'AbortError'); } });
  await ab3.start();
  const r3 = await ab3.chooseFolder();
  check('cancelled picker leaves status off', r3 === 'cancelled' && ab3.getState().status === 'off', `${r3} ${ab3.getState().status}`);

  // 10. Reminder helpers.
  m.markManualExport(new Date(Date.now() - 9 * 86400000));
  check('days since manual export', m.daysSinceManualExport() === 9, m.daysSinceManualExport());
  check('slugify', m.slugify('Room B’s iMac!') === 'room-b-s-imac' && m.slugify('') === 'this-computer', m.slugify('Room B’s iMac!'));
  check('isSupported in Chromium', m.isSupported() === true);

  return out;
});

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.info})`}`);
}
if (errors.length) { console.log('Page errors:', errors); failed++; }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
