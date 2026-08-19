# Hup Gift — /apps directory listing

Ready-to-paste values for the "List your app" form on https://hup.social/apps.

| Field | Value |
| --- | --- |
| Network | LUKSO |
| Name | Hup Gift |
| Description | Community gift rounds paid in LYX. If you're on the round's list — top posters, contributors, winners — one tap claims your share, straight to your wallet. |
| App URL | https://<your-host>/index.html |
| Category | dApp |
| Icon | https://<your-host>/icon.png |
| Repo | (leave empty) |
| Tags | gift, rewards, leaderboard, lyx, community |
| Embed shape | 1:1 |
| Featured | optional — extra fee on top of the listing fee |

## Before pressing List

1. **Host this folder over https first** — the listing pins the App URL's exact origin, and every
   later URL edit pauses embedding until re-review. Any static host works; the frame must NOT be
   on hup.social's own origin (the embed resolver refuses same-origin frames). List `index.html`
   only, never `admin.html`.
2. Flip `HUP_ORIGIN` in `config.js` to `https://hup.social` before deploying to the host.
3. The frame serves the chain it is LISTED on — LUKSO mainnet (42) here, contract
   `0xF94B71443c944Da57137f0C196433a9f8e601B3E`. Create and fund a round there from `admin.html`
   (chain picker → LUKSO) before anyone opens the embed, or it shows "No gift is running".

## After listing

1. Pay the listing fee (one onchain transaction on LUKSO).
2. Grant embed approval from the moderator view on /apps.
3. Attach the app to a post.

The local Dracos listing on 4201 stays as the dev loop — it is DB-only and unrelated to this.
