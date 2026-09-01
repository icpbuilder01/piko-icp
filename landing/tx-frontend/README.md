# PIKO Transaction Lookup -- source

The `/tx/` page served from `landing` (see `../public/tx/`). Written from
scratch 2026-09-01 to replace a previously-committed compiled bundle that
had no matching source anywhere in this repo -- a real transparency gap for
a project whose whole point is byte-for-byte verifiability (see the
security review notes in git history around that date).

Looks up a single PIKO ledger block by index via the official
`ic-icrc1-index-ng` canister's `get_blocks` (see `../../index/`), and
renders the generic `Value` it returns recursively. Anonymous, read-only,
no login -- same posture as the rest of `landing`.

## Building

`landing`'s own `canister.yaml` recipe is `@dfinity/static-site` with
`build: []` -- it serves `../public/` verbatim and has no build step of its
own (see that file's own comment). So unlike `dice-frontend`/
`blackjack-frontend` (each their own canister, built automatically by
`icp deploy`), this page's build has to be run and its output copied into
`../public/tx/` by hand before deploying `landing`:

```sh
npm install
npm run build
rm -rf ../public/tx
cp -r dist ../public/tx
```

Then `icp deploy landing` as usual. Do this any time `src/` changes here --
`../public/tx/` is committed output, not a symlink, so it will silently go
stale otherwise.
