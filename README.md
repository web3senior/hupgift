# Hup Gift 🎁

A one-button **Hup mini app**: the people on a gift round's list claim their share of it from
inside a Hup post. An animated claim button, a thank-you line, nothing else — plus an admin page
for running the rounds.

## How it works

1. An admin opens a **round** on the `HupGift` contract — payout per claim, claim window, title,
   thank-you message — funds it, and adds the eligible addresses. All of that from `admin.html`.
2. The viewer opens the embed. The app asks the host bridge for the viewer's session, then reads
   `getClaimState(0, viewer)` — round `0` means *whichever round is open now*.
3. Everything on screen comes from that one call: the title, the message, the payout, how many
   have claimed, and whether this viewer is on the list.
4. Pressing the button sends `claim(roundId)` — one Hup confirmation — and the contract pays the
   viewer's own wallet with a bare `call`, so Universal Profiles work as well as EOAs.

Nothing about a campaign lives in this repo. A new gift is a funded transaction on the contract;
this app needs no edit, no redeploy, and no release to pick it up.

## Files

| File | What it is |
| --- | --- |
| `index.html` + `app.js` + `styles.css` | The embed: badge, title, message, claim button, receipt |
| `admin.html` + `admin.js` + `admin.css` | Owner tool: create rounds, fund, manage eligibility |
| `abi.js` | The encode/decode primitives both pages share |
| `config.js` | The ONE place deployments live: Hup origin + address/name/symbol/explorer per chain |

No build step, no dependencies.

**Only `index.html` is ever listed and embedded.** The claim frame reaches the wallet solely
through the Hup SDK, as the mini app rules require. `admin.html` is the opposite: it is opened in
a normal browser tab, where there is no Hup host to bridge to, so it talks to the injected wallet
(`window.lukso` for the Universal Profile extension, otherwise `window.ethereum`). Never register
`admin.html` as the App URL.

## Configuration

Everything per-deployment lives in `config.js`, read by both pages — a new chain or a redeploy
is a single edit there and nowhere else:

```js
HUP_ORIGIN        // https://hup.social (or https://localhost:3000 for local Hup)
DEPLOYMENTS       // { chainId: { address, name, symbol, explorer } } — one entry per chain
PRIMARY_CHAIN_ID  // fallback when the host context does not name a chain
```

The frame serves whichever chain the app is LISTED on (the registry chain from the host context),
so the listing must live on a chain that has an entry here.

## Running a round (admin.html)

1. Open `admin.html`, connect the wallet holding `ADMIN_ROLE`, pick the network. The page says so
   plainly if the wallet is not an admin, rather than letting every write revert at you.
2. **New round** — payout per claim, the pool to deposit now, an optional window, the title and
   the thank-you message shown in the post. The summary line spells out what you are about to do
   ("200 LYX at 10 LYX each covers 20 claims"), because the payout and the pool are easy to
   transpose and the contract cannot tell them apart for you.
3. **Manage** on the round → paste the eligible addresses (any text containing them works — one
   per line, comma separated, pasted JSON) and press **Add to round**. Batches of 250, and an
   address already on the list is skipped rather than doubled, so re-running a snapshot is safe.
   **Load top 20 from leaderboard** fills the box for you where the browser allows the read; the
   Hup leaderboard route sends no CORS header, so if it is blocked the page tells you the exact
   URL to open and paste from.
4. Later: **Add funds** to top up, **Save text** to fix the copy, **Save window** to extend a
   deadline, **Send to them** to push the payout to winners who have no gas at all.
5. **Cancel** stops a round permanently; **Withdraw unclaimed** returns the remainder, but only
   after the deadline passes or the round is cancelled — a live round's balance is out of admin
   reach by design.

## Deploy checklist

1. Deploy `HupGift.sol` (hupsocial repo, `src/contracts/v2/Extensions/`) with your admin address
   as the constructor argument. LUKSO Testnet (4201) first.
2. Fill that chain's entry in `config.js` — the only place the address lives. A mini app is
   self-contained; nothing in the Hup repo needs to know about it.
3. Open and fund the round from `admin.html`.
4. Host this folder over https (any static host; make sure no `X-Frame-Options` /
   `frame-ancestors` header blocks framing). Keep `admin.html` off the public host, or behind
   auth — it is only a convenience wrapper around calls `onlyAdmin` already guards, but there is
   no reason to publish it.
5. List the app on https://hup.social/apps — App URL is **index.html**, embed shape
   **Square 1:1** — then ask a moderator for embed approval and attach it to a post. Every later
   edit pauses embedding until re-review, so batch changes.

## Testing standalone

Open `index.html` from any static server: `hup.ready()` rejects, and the app says so rather than
crashing — that is the correct behavior outside a post. The full loop needs the app embedded in a
Hup post, or a stubbed bridge pointed at a local chain.
