/*
 * Hup Gift admin — create and manage gift rounds.
 *
 * A standalone owner tool, NOT the embedded frame: it is opened in a normal browser tab and talks
 * to the injected wallet directly, because there is no Hup host to bridge to outside a post. Only
 * index.html is ever listed and embedded; this page must never be the registered App URL.
 *
 * Every write here is a call the contract's onlyAdmin already guards — this page just spares you
 * hand-encoding calldata in Remix, and shows what a round actually looks like before you fund it.
 */

// --- Config ---
// Deployment addresses and the Hup origin live in config.js, shared with app.js.

// How many accounts "load the top N" pulls from the leaderboard
const TOP_N = 20;

// The contract rejects anything larger per call, so batches are split to match
const MAX_BATCH = 250;

const SELECTORS = {
  ADMIN_ROLE: "0x75b238fc",
  hasRole: "0x91d14854",
  paused: "0x5c975abb",
  roundCount: "0x127f0b3f",
  getRound: "0x8f1327c0",
  eligibleCount: "0x5d0725f0",
  getEligible: "0x925f6380",
  createRound: "0x5d146836",
  fundRound: "0x0dcfb2b8",
  addEligible: "0x575d37bd",
  removeEligible: "0x733d6270",
  distribute: "0x85e3c463",
  cancelRound: "0x7e07ab09",
  withdrawUnclaimed: "0x275dae48",
  setRoundText: "0xea48d3e7",
  setRoundWindow: "0x50c6b55c",
};

// --- State ---

const state = {
  provider: null,
  account: null,
  chainId: null,
  deployment: null,
  isAdmin: false,
  rounds: [],
  open: new Set(), // round ids whose drawer is expanded
};

const el = (id) => document.getElementById(id);

// --- Wallet ---

/** The UP browser extension injects window.lukso; everything else lands on window.ethereum. */
const injected = () => window.lukso || window.ethereum || null;

function banner(text, kind = "warn") {
  const node = el("banner");
  node.textContent = text;
  node.className = `banner${kind === "ok" ? " banner--ok" : kind === "bad" ? " banner--bad" : ""}`;
  node.hidden = !text;
}

async function connect() {
  const wallet = injected();
  if (!wallet) {
    banner(
      "No wallet extension found. Open this page in a browser with MetaMask or the Universal Profile extension.",
      "bad",
    );
    return;
  }

  try {
    state.provider = wallet;

    const accounts = await wallet.request({ method: "eth_requestAccounts" });
    state.account = accounts[0] || null;
    state.chainId = Number(await wallet.request({ method: "eth_chainId" }));

    wallet.on?.("accountsChanged", (list) => {
      state.account = list[0] || null;
      refresh();
    });

    wallet.on?.("chainChanged", (id) => {
      state.chainId = Number(id);
      syncChainSelect();
      refresh();
    });

    syncChainSelect();
    await refresh();
  } catch (error) {
    banner(error?.message || "Could not connect", "bad");
  }
}

async function switchChain(chainId) {
  try {
    await state.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${Number(chainId).toString(16)}` }],
    });
    state.chainId = Number(chainId);
    await refresh();
  } catch (error) {
    banner(error?.message || "Could not switch network", "bad");
    syncChainSelect();
  }
}

// --- Chain access ---

const call = (data) =>
  state.provider.request({
    method: "eth_call",
    params: [{ to: state.deployment.address, data }, "latest"],
  });

async function send(data, value = 0n) {
  const params = { from: state.account, to: state.deployment.address, data };
  if (value > 0n) params.value = `0x${value.toString(16)}`;

  const hash = await state.provider.request({
    method: "eth_sendTransaction",
    params: [params],
  });
  banner(`Sent ${hash.slice(0, 10)}… waiting for confirmation`, "ok");

  for (let attempt = 0; attempt < 90; attempt++) {
    const receipt = await state.provider
      .request({ method: "eth_getTransactionReceipt", params: [hash] })
      .catch(() => null);

    if (receipt) {
      if (BigInt(receipt.status ?? "0x0") === 0n)
        throw new Error("The transaction reverted onchain");
      banner("Confirmed", "ok");
      return receipt;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("Timed out waiting for the receipt — check the explorer");
}

/** Decodes the Round struct returned by getRound. */
function decodeRound(result, id) {
  const body = structBody(result);
  if (!body) return null;

  const funded = toBigInt(wordAt(body, 1));
  const disbursed = toBigInt(wordAt(body, 2));
  const withdrawn = toBigInt(wordAt(body, 3));

  return {
    id,
    amountPerClaim: toBigInt(wordAt(body, 0)),
    funded,
    disbursed,
    withdrawn,
    balance: funded - disbursed - withdrawn,
    startAt: toBigInt(wordAt(body, 4)),
    endAt: toBigInt(wordAt(body, 5)),
    claimCount: toBigInt(wordAt(body, 6)),
    cancelled: toBool(wordAt(body, 7)),
    label: decodeString(body, toBigInt(wordAt(body, 8))),
    message: decodeString(body, toBigInt(wordAt(body, 9))),
  };
}

// --- Loading ---

async function refresh() {
  state.deployment = DEPLOYMENTS[state.chainId] || null;

  if (!state.account) {
    el("connect").textContent = "Connect wallet";
    el("rounds").innerHTML =
      '<p class="muted">Connect a wallet to load rounds.</p>';
    return;
  }

  el("connect").textContent =
    `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;

  if (!state.deployment?.address) {
    banner(
      `No HupGift address configured for chain ${state.chainId}. Fill DEPLOYMENTS in config.js.`,
      "bad",
    );
    el("rounds").innerHTML =
      '<p class="muted">Nothing to show on this network.</p>';
    el("create").disabled = true;
    return;
  }

  try {
    const role = await call(SELECTORS.ADMIN_ROLE);

    // An address with no contract on this network answers every call with empty data, which would
    // otherwise surface as "Cannot convert 0x to a BigInt" three lines later
    if (!role || role === "0x") {
      throw new Error(
        `Nothing answered at ${state.deployment.address} on ${state.deployment.name}. Check the address and the selected network.`,
      );
    }

    const holds = await call(
      encodeCall(
        SELECTORS.hasRole,
        ["bytes32", "address"],
        [role, state.account],
      ),
    );
    state.isAdmin = toBool(String(holds).replace(/^0x/, ""));

    const paused = toBool(
      String(await call(SELECTORS.paused)).replace(/^0x/, ""),
    );

    if (!state.isAdmin)
      banner(
        "This wallet does not hold ADMIN_ROLE — you can read rounds, but every write will revert.",
        "bad",
      );
    else if (paused)
      banner(
        "The contract is paused: claims are frozen until it is unpaused.",
        "warn",
      );
    else banner("");

    el("create").disabled = !state.isAdmin;
    updateSummary();

    const count = Number(
      toBigInt(String(await call(SELECTORS.roundCount)).replace(/^0x/, "")),
    );
    const rounds = [];

    // Newest first — the round you just made is the one you want to act on
    for (let id = count; id >= 1; id--) {
      const round = decodeRound(
        await call(encodeCall(SELECTORS.getRound, ["uint256"], [BigInt(id)])),
        id,
      );
      const eligible = await call(
        encodeCall(SELECTORS.eligibleCount, ["uint256"], [BigInt(id)]),
      );

      round.eligible = Number(toBigInt(String(eligible).replace(/^0x/, "")));
      rounds.push(round);
    }

    state.rounds = rounds;
    renderRounds();
  } catch (error) {
    banner(error?.message || "Could not read the contract", "bad");
  }
}

// --- Rendering ---

const symbol = () => state.deployment?.symbol || "";
const asDate = (seconds) =>
  seconds === 0n ? "—" : new Date(Number(seconds) * 1000).toLocaleString();

function roundStatus(round) {
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (round.cancelled) return { text: "cancelled", kind: "closed" };
  if (round.endAt !== 0n && now > round.endAt)
    return { text: "ended", kind: "closed" };
  if (round.startAt !== 0n && now < round.startAt)
    return { text: "scheduled", kind: "" };
  if (round.balance < round.amountPerClaim)
    return { text: "out of funds", kind: "closed" };

  return { text: "open", kind: "open" };
}

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(text ?? "").replace(/[&<>"']/g, (char) => map[char]);
}

function asLocalInput(seconds) {
  if (seconds === 0n) return "";

  const date = new Date(Number(seconds) * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const toUnix = (localValue) =>
  localValue ? BigInt(Math.floor(new Date(localValue).getTime() / 1000)) : 0n;

function renderRounds() {
  const host = el("rounds");

  if (!state.rounds.length) {
    host.innerHTML = '<p class="muted">No rounds yet. Create one above.</p>';
    return;
  }

  host.innerHTML = "";

  for (const round of state.rounds) {
    const status = roundStatus(round);
    const node = document.createElement("article");
    node.className = "round";

    const stat = (value, label) =>
      `<div class="stat"><span class="stat__value">${value}</span><span class="stat__label">${label}</span></div>`;

    node.innerHTML = `
      <div class="round__head">
        <span class="round__title">${escapeHtml(round.label) || "(no title)"} <span class="round__id">#${round.id}</span></span>
        <span class="tag ${status.kind ? `tag--${status.kind}` : ""}">${status.text}</span>
      </div>
      <p class="muted">${escapeHtml(round.message) || "(no message)"}</p>
      <div class="round__stats">
        ${stat(`${formatAmount(round.amountPerClaim)} ${symbol()}`, "per claim")}
        ${stat(`${formatAmount(round.balance)} ${symbol()}`, "remaining")}
        ${stat(`${round.claimCount} / ${round.eligible}`, "claimed / eligible")}
        ${stat(round.amountPerClaim > 0n ? String(round.balance / round.amountPerClaim) : "0", "claims left")}
        ${stat(asDate(round.startAt), "opens")}
        ${stat(asDate(round.endAt), "closes")}
      </div>
      <div class="round__actions">
        <button class="btn" data-act="toggle">${state.open.has(round.id) ? "Hide" : "Manage"}</button>
        <button class="btn" data-act="fund">Add funds</button>
        <button class="btn btn--danger" data-act="cancel" ${round.cancelled ? "disabled" : ""}>Cancel</button>
        <button class="btn btn--danger" data-act="withdraw">Withdraw unclaimed</button>
      </div>
    `;

    node.querySelector('[data-act="toggle"]').onclick = () => {
      if (state.open.has(round.id)) state.open.delete(round.id);
      else state.open.add(round.id);
      renderRounds();
    };

    node.querySelector('[data-act="fund"]').onclick = () =>
      guard(() => fundRound(round));
    node.querySelector('[data-act="cancel"]').onclick = () =>
      guard(() => cancelRound(round));
    node.querySelector('[data-act="withdraw"]').onclick = () =>
      guard(() => withdrawRound(round));

    if (state.open.has(round.id)) node.appendChild(drawer(round));

    host.appendChild(node);
  }
}

function drawer(round) {
  const box = document.createElement("div");
  box.className = "round__drawer";

  box.innerHTML = `
    <label class="field">
      <span class="field__label">Eligible accounts</span>
      <textarea class="field__area" data-role="addresses" placeholder="0xabc…"></textarea>
      <small class="field__hint">Any text containing addresses works — one per line, comma separated, pasted JSON. Sent in batches of ${MAX_BATCH}; an address already on the list is skipped, not doubled.</small>
    </label>
    <div class="row">
      <button class="btn" data-act="load-top">Load top ${TOP_N} from leaderboard</button>
      <button class="btn" data-act="show-list">Show current list</button>
      <button class="btn btn--primary" data-act="add">Add to round</button>
      <button class="btn btn--danger" data-act="remove">Remove from round</button>
      <button class="btn" data-act="push">Send to them (no claim needed)</button>
    </div>
    <p class="mono muted" data-role="list"></p>
    <div class="row">
      <input class="field__input" data-role="label" placeholder="Title" value="${escapeHtml(round.label)}" maxlength="80" />
      <input class="field__input" data-role="message" placeholder="Thank-you message" value="${escapeHtml(round.message)}" maxlength="160" />
      <button class="btn" data-act="text">Save text</button>
    </div>
    <div class="row">
      <input class="field__input" type="datetime-local" data-role="start" value="${asLocalInput(round.startAt)}" />
      <input class="field__input" type="datetime-local" data-role="end" value="${asLocalInput(round.endAt)}" />
      <button class="btn" data-act="window">Save window</button>
    </div>
  `;

  const field = (role) => box.querySelector(`[data-role="${role}"]`);
  const addresses = () => parseAddresses(field("addresses").value);

  box.querySelector('[data-act="load-top"]').onclick = () =>
    guard(() => loadTop(field("addresses")), false);
  box.querySelector('[data-act="show-list"]').onclick = () =>
    guard(() => showList(round, field("list")), false);
  box.querySelector('[data-act="add"]').onclick = () =>
    guard(() => batchWrite(SELECTORS.addEligible, round, addresses(), "Added"));
  box.querySelector('[data-act="remove"]').onclick = () =>
    guard(() =>
      batchWrite(SELECTORS.removeEligible, round, addresses(), "Removed"),
    );
  box.querySelector('[data-act="push"]').onclick = () =>
    guard(() => batchWrite(SELECTORS.distribute, round, addresses(), "Sent"));
  box.querySelector('[data-act="text"]').onclick = () =>
    guard(() => saveText(round, field("label").value, field("message").value));
  box.querySelector('[data-act="window"]').onclick = () =>
    guard(() => saveWindow(round, field("start").value, field("end").value));

  return box;
}

// --- Actions ---

/** Runs an action, surfaces whatever it throws, and reloads unless the action was read-only. */
async function guard(action, reload = true) {
  try {
    await action();

    // refresh() resets the banner to the contract's standing status, which would swallow the
    // "Added 12 accounts" the caller just put there — so carry the action's own word over it.
    const node = el("banner");
    const said = { text: node.textContent, className: node.className };

    if (reload) await refresh();

    if (said.text) {
      node.textContent = said.text;
      node.className = said.className;
      node.hidden = false;
    }
  } catch (error) {
    banner(error?.message || String(error), "bad");
  }
}

function parseAddresses(text) {
  const found = String(text || "").match(/0x[a-fA-F0-9]{40}/g) || [];
  return [...new Set(found.map((address) => address.toLowerCase()))];
}

async function loadTop(target) {
  const url = `${HUP_ORIGIN}/api/v1/leaderboard?limit=${TOP_N}&sort=score&period=all`;

  try {
    const response = await fetch(url);
    const json = await response.json();
    const addresses = (json?.data || [])
      .map((row) => row.wallet_address)
      .filter(Boolean);

    if (!addresses.length)
      throw new Error("the leaderboard returned no accounts");

    target.value = addresses.join("\n");
    banner(
      `Loaded ${addresses.length} accounts — check the list, then press Add to round.`,
      "ok",
    );
  } catch (error) {
    // The leaderboard route sends no CORS header, so a cross-origin read fails by design
    banner(
      `Could not read the leaderboard from here (${error.message}). Open ${url} in a tab and paste the wallet_address values in instead.`,
      "warn",
    );
  }
}

async function showList(round, target) {
  const result = await call(
    encodeCall(
      SELECTORS.getEligible,
      ["uint256", "uint256", "uint256"],
      [BigInt(round.id), 0n, BigInt(MAX_BATCH)],
    ),
  );
  const list = decodeAddressArray(result);

  target.textContent = list.length
    ? list.join("  ")
    : "No accounts on this round yet.";
}

async function batchWrite(selector, round, addresses, verb) {
  if (!addresses.length) throw new Error("No addresses in the box");

  for (let index = 0; index < addresses.length; index += MAX_BATCH) {
    await send(
      encodeCall(
        selector,
        ["uint256", "address[]"],
        [BigInt(round.id), addresses.slice(index, index + MAX_BATCH)],
      ),
    );
  }

  banner(
    `${verb} ${addresses.length} account${addresses.length === 1 ? "" : "s"}`,
    "ok",
  );
}

async function fundRound(round) {
  const input = window.prompt(
    `How much ${symbol()} should go into round #${round.id}?`,
  );
  if (input === null) return;

  const value = parseAmount(input);
  if (!value) throw new Error("Enter an amount like 50 or 0.5");

  await send(
    encodeCall(SELECTORS.fundRound, ["uint256"], [BigInt(round.id)]),
    value,
  );
}

async function cancelRound(round) {
  if (
    !window.confirm(
      `Cancel round #${round.id}? Nobody can claim from it again, and this cannot be undone.`,
    )
  )
    return;

  await send(
    encodeCall(SELECTORS.cancelRound, ["uint256"], [BigInt(round.id)]),
  );
}

async function withdrawRound(round) {
  const to = window.prompt(
    "Send the unclaimed remainder to which address?",
    state.account,
  );
  if (!to) return;
  if (!/^0x[a-fA-F0-9]{40}$/.test(to.trim()))
    throw new Error("That is not an address");

  await send(
    encodeCall(
      SELECTORS.withdrawUnclaimed,
      ["uint256", "address"],
      [BigInt(round.id), to.trim()],
    ),
  );
}

async function saveText(round, label, message) {
  await send(
    encodeCall(
      SELECTORS.setRoundText,
      ["uint256", "string", "string"],
      [BigInt(round.id), label, message],
    ),
  );
}

async function saveWindow(round, start, end) {
  await send(
    encodeCall(
      SELECTORS.setRoundWindow,
      ["uint256", "uint64", "uint64"],
      [BigInt(round.id), toUnix(start), toUnix(end)],
    ),
  );
}

async function createRound() {
  const amount = parseAmount(el("amount").value);
  if (!amount) throw new Error("Enter a payout per claim, like 10");

  const funding = el("funding").value.trim()
    ? parseAmount(el("funding").value)
    : 0n;
  if (funding === null) throw new Error("That pool amount is not a number");

  await send(
    encodeCall(
      SELECTORS.createRound,
      ["uint256", "uint64", "uint64", "string", "string"],
      [
        amount,
        toUnix(el("start").value),
        toUnix(el("end").value),
        el("label").value.trim(),
        el("message").value.trim(),
      ],
    ),
    funding,
  );

  for (const id of ["amount", "funding", "label", "message"]) el(id).value = "";
  updateSummary();
}

/** Spells out what the form will do — the payout and the pool are easy to transpose. */
function updateSummary() {
  const amount = parseAmount(el("amount").value);
  const funding = parseAmount(el("funding").value);
  const unit = symbol();

  el("amount-hint").textContent =
    `What each eligible account can claim${unit ? `, in ${unit}` : ""}.`;

  if (!amount || !funding) {
    el("create-summary").textContent = "";
    return;
  }

  const claims = funding / amount;
  el("create-summary").textContent =
    `${formatAmount(funding)} ${unit} at ${formatAmount(amount)} ${unit} each covers ${claims} claim${claims === 1n ? "" : "s"}.`;
}

// --- Chain picker ---

function syncChainSelect() {
  const select = el("chain");
  select.innerHTML = "";

  for (const [id, deployment] of Object.entries(DEPLOYMENTS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent =
      deployment.name + (deployment.address ? "" : " (no address)");
    option.selected = Number(id) === state.chainId;
    select.appendChild(option);
  }

  if (state.chainId && !DEPLOYMENTS[state.chainId]) {
    const option = document.createElement("option");
    option.value = String(state.chainId);
    option.textContent = `Chain ${state.chainId}`;
    option.selected = true;
    select.appendChild(option);
  }
}

// --- Boot ---

el("connect").onclick = connect;
el("refresh").onclick = () => refresh();
el("create").onclick = () => guard(createRound);
el("chain").onchange = (event) => switchChain(event.target.value);
el("amount").oninput = updateSummary;
el("funding").oninput = updateSummary;

syncChainSelect();

// Reconnect silently if the wallet already authorised this origin
async function resume() {
  const wallet = injected();
  if (!wallet) return;

  const accounts = await wallet
    .request({ method: "eth_accounts" })
    .catch(() => []);
  if (accounts.length) await connect();
}

resume();
