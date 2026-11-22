# Gear Locker Sync on Cloudflare

Status: plan, not built yet. Building it needs the app source in this repo.

## Goal

Let a Full Locker owner keep the same locker on several devices (studio Mac,
laptop, Android) without creating an account and without Oakline Labs being
able to read their data.

## Principles

- **Off by default.** Gear Locker still works with no account and no network.
- **End-to-end encrypted.** Data is encrypted in the browser before upload.
  The server stores ciphertext only. Losing the passphrase means the synced
  copy can't be recovered. The local backup export stays as the safety net.
- **Offline first.** Edits are saved locally and queued. They sync when the
  device is next online.
- **License key = identity.** No email or password. The existing signed
  license proves the right to sync.

## Architecture

```
Browser / Android app                      Cloudflare
-------------------------                  -----------------------------
Local store (IndexedDB)                    Worker  (API, auth, quotas)
  │                                          │
  ├─ encrypt record (AES-GCM) ───HTTPS────►  ├─ D1:  record index + ciphertext
  │                                          │        (small records)
  └─ encrypt photo blob ─────────HTTPS────►  └─ R2:  encrypted photo blobs
```

### Keys

1. User picks a sync passphrase when turning sync on.
2. Derive a 256-bit key with PBKDF2-SHA-256 (600,000 iterations) from the
   passphrase and a random salt. The salt is stored on the server per license;
   it is not secret.
3. Every record and photo is encrypted with AES-256-GCM and a fresh 96-bit IV.
4. A second device enters the same passphrase, downloads the salt, and derives
   the same key. The key never leaves a device.

All of this is available in the browser's built-in WebCrypto API, so the app
needs no extra crypto library.

### Identity and auth

- `POST /v1/devices` with the signed license. The Worker verifies the
  signature with the public key the app already uses for offline activation,
  then returns a device token.
- The server stores only `sha256(license id)`, never the license itself.
- Each device token can be revoked from any other device ("Remove this device").

### Data model (D1)

| table      | columns                                                                 |
|------------|-------------------------------------------------------------------------|
| `lockers`  | `locker_id` (hash of license id), `salt`, `bytes_used`, `created_at`    |
| `devices`  | `device_id`, `locker_id`, `token_hash`, `label`, `last_seen`           |
| `records`  | `locker_id`, `record_id`, `kind`, `version`, `updated_at`, `deleted`, `ciphertext` |

`kind` is one of gear, patch, session, service, photo-ref. The server can see
the kind and the size, nothing else.

Photos go to R2 at `lockers/<locker_id>/<photo_id>` as encrypted blobs, with
the record in D1 pointing to them.

### API (Worker)

| method | path                           | purpose                                   |
|--------|--------------------------------|-------------------------------------------|
| POST   | `/v1/devices`                  | register device with a signed license     |
| DELETE | `/v1/devices/:id`              | revoke a device                           |
| GET    | `/v1/salt`                     | fetch the key-derivation salt             |
| GET    | `/v1/changes?since=<cursor>`   | pull records changed since a cursor       |
| POST   | `/v1/changes`                  | push a batch of encrypted records         |
| PUT    | `/v1/blobs/:photo_id`          | upload an encrypted photo                 |
| GET    | `/v1/blobs/:photo_id`          | download an encrypted photo               |

### Conflicts

Per-record last-writer-wins on `updated_at`, with `version` as a tiebreaker.
Deletes are tombstones (`deleted = 1`) kept for 90 days. Patches and sessions
are small records, so a conflict loses at most one edit to one patch. When the
app sees two edits to the same record from different devices within a minute,
it keeps both and shows "Two versions of this patch". That's cheap to add and
avoids silent loss.

### Quotas

- 250 MB per locker (photos are almost all of it).
- Photos shrunk on the device to a 2048 px long edge as WebP or JPEG before
  encryption.
- Rate limit pushes per device in the Worker.

## Cost

The project is already on Cloudflare. Free-tier allowances as understood at
the time of writing (check current pricing before launch):

| service        | free allowance                                              | paid                          |
|----------------|-------------------------------------------------------------|-------------------------------|
| Workers        | 100,000 requests/day                                        | $5/month plan, 10M req/month  |
| D1             | 5 GB storage, 5M rows read/day, 100k rows written/day       | usage-based above that        |
| R2             | 10 GB-month storage, 1M writes, 10M reads/month, no egress fees | about $0.015/GB-month      |

Rough estimate: a typical locker is under 1 MB of records plus 20–60 MB of
compressed photos. Up to a few hundred active sync users fits in the free
tier. After that, expect about $5/month for Workers plus roughly $0.50–$1 per
1,000 users per month for R2 storage.

Including sync in the one-time $14 Full Locker is sustainable at these costs
as long as the storage cap holds.

## Rollout

1. **Phase 0, free and immediate:** "Auto-backup to a folder" using the
   browser's File System Access API (Chrome and Edge on desktop). The user
   picks a folder in iCloud Drive or Dropbox. No server, no cost. Not real
   sync, but it removes most of the data-loss risk now.
2. **Phase 1:** Worker + D1 for records only (no photos). Two-device sync
   behind a "Labs" switch for Full Locker owners.
3. **Phase 2:** Encrypted photos in R2, device management screen, quota UI.
4. **Phase 3:** Android app on the same API.

## Open questions

- Where the app source lives, and how it stores data today (IndexedDB schema).
- Whether the license format can carry a stable license id for hashing.
- Passphrase recovery: none (strongest privacy) or an optional printed
  recovery code (recommended).
