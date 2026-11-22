# Gear Locker

Save the settings on your gear and recall them later. By Oakline Labs.

## What's in this repo

| path                          | what it is                                                          |
|-------------------------------|---------------------------------------------------------------------|
| `prototype/direction-a/`      | Clickable redesign prototype ("The Bench"), home-studio focus        |
| `docs/sync-cloudflare.md`     | Plan for end-to-end encrypted sync on Cloudflare Workers, D1 and R2  |
| `auto-backup/`                | Phase 0: automatic backup to a folder (iCloud Drive, Dropbox), ready to wire into the app. See `auto-backup/INTEGRATION.md` |

The production site source is not in this repo yet.

## Run the prototype locally

The page loads the gear illustrations with `fetch`, so open it through a
local web server rather than as a file:

```bash
cd prototype/direction-a && python3 -m http.server 8000
```

Then open http://localhost:8000.

### What the prototype covers

- Homepage with a playable 1176LN hero, using the existing template
  illustrations. Knobs turn on the unit itself, with clock-position readouts
  and saved, recallable patches.
- Template library with category filters.
- Patch, session and recall sheet section.
- Sync section and pricing with sync in Full Locker.
- First run in the app at `#start`: pick a piece, dial it in, see it in your
  locker.
- Light and dark themes, collapsing navigation on phones.

### Palette

Built from the WGSN x Coloro Spring/Summer 2027 key colours, adapted for
screens: Energy Orange for actions and recalled values, Clay-tinted neutrals,
and Meadowland Green for "synced" and "OK" states. Tokens are at the top of the
`<style>` block in `prototype/direction-a/index.html`.
