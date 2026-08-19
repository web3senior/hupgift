/*
 * Hup Gift — claim your share of a gift round, from inside a Hup post.
 *
 * One animated button and a thank-you line, both driven entirely by the round onchain: the payout
 * size, the deadline, who may claim, the title and the message all come from HupGift, so a new
 * campaign is a funded transaction and nothing else — no edit here, no redeploy.
 *
 * No wallet connectors, no web3 libraries, no build step. The only wallet path is the provider
 * handed over by the Hup SDK, per the mini app rules.
 */

// --- Config ---
// Deployment addresses and the Hup origin live in config.js, shared with admin.js.

// From the compiled HupGift ABI — keep in sync with the deployed source
const SELECTORS = {
  claim: "0x379607f5", // claim(uint256)
  getClaimState: "0xae6c8146", // getClaimState(uint256,address)
};

// ready() waits 5s per try, so this is ~20s of patience before giving up on the host
const HANDSHAKE_ATTEMPTS = 4;

// Round 0 asks the contract for whichever round is open now
const ACTIVE_ROUND = 0n;

const DEFAULT_TITLE = "A gift from Hup";
const DEFAULT_MESSAGE = "Thanks for being with us.";

// --- State ---

const state = {
  provider: null,
  account: null,
  chainId: null,
  deployment: null,
  round: null,
  pinnedRoundId: null, // survives its own claim: the last share drains the round
  busy: false,
  txHash: null,
};

// --- DOM ---

const el = (id) => document.getElementById(id);
const ui = {
  gift: el("gift"),
  title: el("title"),
  message: el("message"),
  claim: el("claim"),
  note: el("note"),
  meta: el("meta"),
  receipt: el("receipt"),
};

// --- Contract decoding ---
// The encode/decode primitives live in abi.js, shared with the admin page so the two can't drift.

/** Decodes the ClaimState struct returned by getClaimState. */
function decodeClaimState(result) {
  const body = structBody(result);
  if (!body) return null;

  return {
    roundId: toBigInt(wordAt(body, 0)),
    amountPerClaim: toBigInt(wordAt(body, 1)),
    eligibleCount: toBigInt(wordAt(body, 2)),
    claimCount: toBigInt(wordAt(body, 3)),
    balance: toBigInt(wordAt(body, 4)),
    startAt: toBigInt(wordAt(body, 5)),
    endAt: toBigInt(wordAt(body, 6)),
    eligible: toBool(wordAt(body, 7)),
    claimed: toBool(wordAt(body, 8)),
    open: toBool(wordAt(body, 9)),
    cancelled: toBool(wordAt(body, 10)),
    label: decodeString(body, toBigInt(wordAt(body, 11))),
    message: decodeString(body, toBigInt(wordAt(body, 12))),
  };
}

const amountLabel = () =>
  `${formatAmount(state.round.amountPerClaim)} ${state.deployment.symbol}`;

// --- Chain access (always through the host bridge) ---

function loadHupSdk() {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${HUP_ORIGIN}/miniapp-sdk.js`;
    script.onload = () => resolve(window.hup);
    script.onerror = () => reject(new Error("SDK unreachable"));
    document.head.appendChild(script);
  });
}

async function readClaimState() {
  const roundId = state.pinnedRoundId ?? ACTIVE_ROUND;
  const data =
    SELECTORS.getClaimState + pad32(roundId) + pad32(state.account || "0x0");

  const result = await state.provider.request({
    method: "eth_call",
    params: [{ to: state.deployment.address, data }, "latest"],
  });

  return decodeClaimState(result);
}

async function waitForReceipt(hash) {
  // ~2 minutes at 2s intervals; the button stays in its pending state throughout
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await state.provider
      .request({ method: "eth_getTransactionReceipt", params: [hash] })
      .catch(() => null);
    if (receipt) return receipt;

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return null;
}

// --- Rendering ---

function paint({
  title,
  message,
  button,
  note = "",
  meta = "",
  variant = "idle",
  disabled = true,
}) {
  ui.title.textContent = title;
  ui.message.textContent = message;
  ui.claim.textContent = button;
  ui.claim.disabled = disabled;
  ui.note.textContent = note;
  ui.meta.textContent = meta;

  ui.gift.classList.toggle("gift--live", variant === "live");
  ui.gift.classList.toggle("gift--claimed", variant === "claimed");
  ui.claim.classList.toggle("gift__claim--ready", variant === "live");
  ui.claim.classList.toggle("gift__claim--done", variant === "claimed");

  if (state.txHash && state.deployment?.explorer) {
    ui.receipt.href = `${state.deployment.explorer}/tx/${state.txHash}`;
    ui.receipt.hidden = false;
  }
}

function render() {
  const round = state.round;

  if (!round || round.roundId === 0n) {
    paint({
      title: DEFAULT_TITLE,
      message: "No gift is running right now.",
      button: "Nothing to claim",
      note: "Check back after the next round opens.",
    });
    return;
  }

  const title = round.label || DEFAULT_TITLE;
  const message = round.message || DEFAULT_MESSAGE;
  const meta = `${round.claimCount} of ${round.eligibleCount} claimed on ${state.deployment.name}`;

  if (state.busy) {
    paint({
      title,
      message,
      button: "Claiming…",
      note: "Waiting for the network to confirm.",
      meta,
    });
    return;
  }

  if (round.claimed) {
    paint({
      title,
      message,
      button: "Claimed",
      note: `${amountLabel()} is on its way to your wallet. Thank you for being here.`,
      meta,
      variant: "claimed",
    });
    return;
  }

  // Nothing this app can do about it: the wallet belongs to the host, and eth_requestAccounts is
  // answered from the Hup session rather than prompting. So the button stays calm and explains,
  // instead of pulsing at a viewer who cannot press it.
  if (!state.account) {
    paint({
      title,
      message,
      button: "Connect in Hup to claim",
      note: "Connect your wallet in Hup, then reopen this gift.",
      meta,
    });
    return;
  }

  if (!round.eligible) {
    paint({
      title,
      message,
      button: "Not on this list",
      note:
        round.eligibleCount > 0n
          ? `This round is for ${round.eligibleCount} accounts, and yours is not among them this time.`
          : "This round has no accounts on its list yet.",
      meta,
    });
    return;
  }

  if (!round.open) {
    paint({
      title,
      message,
      button: "Round closed",
      note: "Thank you for being part of it.",
      meta,
    });
    return;
  }

  paint({
    title,
    message,
    button: `Claim ${amountLabel()}`,
    note: `${amountLabel()} is waiting for you.`,
    meta,
    variant: "live",
    disabled: false,
  });
}

function fail(note) {
  state.round = null;
  paint({
    title: DEFAULT_TITLE,
    message: "This gift needs the Hup app.",
    button: "Unavailable",
    note,
  });
}

// --- Claiming ---

async function claim() {
  if (state.busy || !state.round || !state.account) return;

  state.busy = true;
  render();

  try {
    const hash = await state.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: state.account,
          to: state.deployment.address,
          data: SELECTORS.claim + pad32(state.round.roundId),
          value: "0x0",
        },
      ],
    });

    // Pin the round before it can drain: claiming the last share closes it, and a closed round
    // stops answering the "whichever round is open now" query the page opened with.
    state.pinnedRoundId = state.round.roundId;
    state.txHash = hash;

    const receipt = await waitForReceipt(hash);
    state.busy = false;

    if (receipt && BigInt(receipt.status ?? "0x0") === 0n) {
      state.round = await readClaimState();
      render();
      ui.note.textContent = "The claim was rejected onchain. Nothing was sent.";
      return;
    }

    state.round = await readClaimState();
    render();
  } catch (error) {
    state.busy = false;
    render();
    // 4001 is the viewer declining the Hup confirmation — not worth an alarming message
    ui.note.textContent =
      error?.code === 4001
        ? "Claim cancelled."
        : error?.message || "Could not claim the gift.";
  }
}

// --- Boot ---

/**
 * Completes the host handshake, retrying rather than trusting a single attempt.
 *
 * `ready()` sends one handshake and rejects after 5s of silence. The host attaches its side of
 * the bridge in a React effect — and re-attaches it whenever the viewer's session or chain
 * changes — so a frame served off a fast local host can fire its handshake into a gap where
 * nobody is listening yet, and then wait forever on a bridge that came up a moment later. Each
 * retry re-sends the handshake, which a host that attached late will answer.
 */
async function handshake(hup) {
  for (let attempt = 1; attempt <= HANDSHAKE_ATTEMPTS; attempt++) {
    try {
      return await hup.ready();
    } catch (error) {
      // Standalone is not a race: there is genuinely no parent, and no retry will conjure one
      if (window.parent === window || attempt === HANDSHAKE_ATTEMPTS)
        throw error;
    }
  }
}

async function main() {
  let hup;
  try {
    hup = await loadHupSdk();
  } catch {
    fail("Could not load the Hup SDK. Reload the post and try again.");
    return;
  }

  paint({
    title: DEFAULT_TITLE,
    message: "Connecting to Hup…",
    button: "Connecting…",
  });

  let context;
  try {
    context = await handshake(hup);
  } catch {
    // Outside a post this is the documented, expected outcome. Inside one it means the bridge
    // never answered, which reloading the post usually settles — say which of the two happened.
    fail(
      window.parent === window
        ? "Open this app inside a Hup post to claim your gift."
        : "Hup did not answer. Reload the post and try again.",
    );
    return;
  }

  state.provider = await hup.getProvider();
  state.account = context.user?.address || null;

  // The host bridge executes every read AND write on the chain this app is LISTED on — the
  // registry chain, carried in ctx.app — never on the viewer's wallet chain (the host switches
  // the wallet itself when it sends the claim). So the listing's chain decides which deployment
  // this frame serves, and asking the wallet to switch here would change nothing.
  state.chainId = Number(context.app?.chainId) || PRIMARY_CHAIN_ID;
  state.deployment = DEPLOYMENTS[state.chainId];

  if (!state.deployment?.address) {
    fail("This gift is not set up on the network this app is listed on.");
    return;
  }

  hup.on("session", async (session) => {
    state.account = session.address || null;
    state.round = await readClaimState().catch(() => state.round);
    render();
  });

  ui.claim.addEventListener("click", claim);

  try {
    state.round = await readClaimState();
  } catch {
    fail("Could not reach the gift contract. Reload the post and try again.");
    return;
  }

  render();
}

main().catch(() =>
  fail("Something went wrong. Reload the post and try again."),
);
