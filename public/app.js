let state = null;
let socket = null;
let pending = null;
let timer = null;

const $ = id => document.getElementById(id);
const PLAYER_STORAGE_KEY = "stasis-player";
let configBaseFromServer = null;

async function load() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    state = await response.json();
    render();
  } catch {
    toast("Unable to load dashboard state.");
  }
}

function connect() {
  clearTimeout(timer);

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(
    protocol + "://" + location.host + "/ws?role=browser"
  );

  socket.onopen = () => {
    $("dot").classList.remove("offline");
    $("connectionText").textContent = "Connected";
  };

  socket.onclose = () => {
    $("dot").classList.add("offline");
    $("connectionText").textContent = "Disconnected";
    timer = setTimeout(connect, 2500);
  };

  socket.onmessage = event => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "state") {
      state = message.state;
      render();
      return;
    }

    if (message.type === "chamber") {
      if (!state) return;

      const chamber = state.chambers.find(
        item => item.key === message.chamber
      );

      if (chamber) {
        Object.assign(chamber, message.state);
      } else {
        state.chambers.push(message.state);

        let base = state.bases.find(
          item => Number(item.id) === Number(message.state.base)
        );

        if (!base) {
          base = {
            id: message.state.base,
            name: message.state.baseName || "Base " + message.state.base,
            chambers: []
          };
          state.bases.push(base);
        }

        if (!base.chambers.includes(message.state.key)) {
          base.chambers.push(message.state.key);
        }
      }

      if (Number.isInteger(message.playerCount)) {
        state.playerCount = message.playerCount;
      }

      render();
      return;
    }

    if (message.type === "log") {
      if (!state) return;

      state.logs = [message.entry, ...state.logs].slice(0, 50);
      logs();
    }
  };
}

function stats() {
  $("total").textContent = state.chambers.length;
  $("players").textContent = Number.isInteger(state.playerCount)
    ? state.playerCount
    : 0;
  $("basesCount").textContent = state.bases.length;
}

function chamberForKey(key) {
  return state.chambers.find(chamber => chamber.key === key);
}

function render() {
  stats();

  const root = $("bases");
  root.innerHTML = "";

  for (const base of state.bases) {
    const section = document.createElement("section");

    section.innerHTML =
      '<div class="base-title">' +
        '<div>' +
          '<span class="eyebrow">STASIS NETWORK</span>' +
          '<h3>' + esc(base.name) + "</h3>" +
        "</div>" +
        '<span class="base-count">' +
          base.chambers.length +
          " CHAMBERS" +
        "</span>" +
      "</div>" +
      '<div class="grid"></div>';

    const grid = section.querySelector(".grid");

    for (const key of base.chambers) {
      const chamber = chamberForKey(key);

      if (!chamber) continue;

      const card = document.createElement("article");
      card.className = "card " + (chamber.status || "empty");

      const status =
        chamber.status === "pulling"
          ? "PULLING"
          : chamber.status === "pulled"
            ? "PULLED"
            : chamber.player
              ? "READY"
              : "EMPTY";

      const canPull =
        Boolean(chamber.player) &&
        chamber.status === "ready";

      card.innerHTML =
        '<div class="card-top">' +
          '<span class="number">CHAMBER ' +
            String(chamber.id).padStart(2, "0") +
          "</span>" +
          '<span class="status ' +
            esc(chamber.status || "empty") +
          '">' +
            status +
          "</span>" +
        "</div>" +
        '<div class="player">' +
          esc(chamber.player || "No player") +
        "</div>" +
        '<div class="label">' +
          esc(chamber.label) +
        "</div>" +
        '<button class="pull" ' +
          (canPull ? "" : "disabled") +
        ">PULL PEARL</button>";

      card.querySelector(".pull").onclick = () => openPull(chamber);
      grid.appendChild(card);
    }

    root.appendChild(section);
  }

  logs();
}

function logs() {
  const element = $("logs");

  if (!state.logs.length) {
    element.innerHTML =
      '<div class="empty-log">No activity yet.</div>';
    return;
  }

  element.innerHTML = state.logs.map(entry =>
    '<div class="log">' +
      '<span class="log-time">' +
        esc(new Date(entry.time).toLocaleTimeString()) +
      "</span>" +
      '<span class="log-type">' +
        esc(entry.type) +
      "</span>" +
      "<span>" +
        esc(entry.player || "—") +
        ' <span class="log-detail">Chamber ' +
          esc(entry.chamber ?? "—") +
        "</span></span>" +
    "</div>"
  ).join("");
}

function openPull(chamber) {
  pending = chamber;

  $("modalTitle").textContent =
    "Pull " + chamber.player + "?";

  $("modalText").textContent =
    chamber.baseName +
    " • " +
    chamber.label;

  $("modal").classList.remove("hidden");
  $("confirm").focus();
}

function close() {
  pending = null;
  $("modal").classList.add("hidden");
}

async function pull() {
  if (!pending) return;

  const chamber = pending;
  $("confirm").disabled = true;

  try {
    const response = await fetch("/api/pull", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        base: chamber.base,
        chamber: chamber.id
      })
    });

    const result = await response.json();

    if (!response.ok) {
      toast(result.error || "Pull failed");
    } else {
      toast(chamber.player + " pull command sent");
    }
  } catch {
    toast("Unable to contact server");
  } finally {
    $("confirm").disabled = false;
    close();
  }
}

function openConfig() {
  const savedPlayer = localStorage.getItem(PLAYER_STORAGE_KEY) || "";
  $("configPlayer").value = savedPlayer;
  $("configStatus").textContent = "";

  populateConfigBases();

  $("configModal").classList.remove("hidden");
  $("configPlayer").focus();

  if (savedPlayer) {
    loadPreference(savedPlayer);
  }
}

function closeConfig() {
  $("configModal").classList.add("hidden");
}

function populateConfigBases(selected = configBaseFromServer) {
  const select = $("configBase");
  const bases = [...(state?.bases || [])];

  select.innerHTML = "";

  if (selected !== null && selected !== undefined &&
      !bases.some(base => Number(base.id) === Number(selected))) {
    bases.push({
      id: Number(selected),
      name: "Base " + selected + " (offline)"
    });
  }

  bases.sort((a, b) => Number(a.id) - Number(b.id));

  if (!bases.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No bases connected";
    select.appendChild(option);
    select.disabled = true;
    $("configSave").disabled = true;
    return;
  }

  select.disabled = false;
  $("configSave").disabled = false;

  for (const base of bases) {
    const option = document.createElement("option");
    option.value = String(base.id);
    option.textContent =
      base.name + (base.chambers ? " • " + base.chambers.length + " chambers" : "");
    select.appendChild(option);
  }

  if (selected !== null && selected !== undefined) {
    select.value = String(selected);
  }
}

async function loadPreference(player) {
  try {
    const response = await fetch(
      "/api/preference?player=" + encodeURIComponent(player),
      { cache: "no-store" }
    );

    if (!response.ok) return;

    const result = await response.json();
    configBaseFromServer = result.defaultBase;

    if (result.defaultBase !== null && result.defaultBase !== undefined) {
      populateConfigBases(result.defaultBase);
    }

    $("configStatus").textContent =
      result.defaultBase === null || result.defaultBase === undefined
        ? "No default base saved yet."
        : "Saved default: Base " + result.defaultBase;
  } catch {
    $("configStatus").textContent = "Unable to load saved configuration.";
  }
}

async function saveConfig() {
  const player = $("configPlayer").value.trim();
  const defaultBase = Number($("configBase").value);

  if (!player) {
    $("configStatus").textContent = "Enter your Minecraft player name.";
    $("configPlayer").focus();
    return;
  }

  if (!Number.isInteger(defaultBase)) {
    $("configStatus").textContent = "Select a base.";
    return;
  }

  $("configSave").disabled = true;

  try {
    const response = await fetch("/api/preference", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        player,
        defaultBase
      })
    });

    const result = await response.json();

    if (!response.ok) {
      $("configStatus").textContent =
        result.error || "Unable to save configuration.";
      return;
    }

    localStorage.setItem(PLAYER_STORAGE_KEY, player);
    configBaseFromServer = result.defaultBase;
    $("configStatus").textContent =
      "Saved. Discord /pull will use Base " + result.defaultBase + " for " + player + ".";
    toast("Default base saved");
  } catch {
    $("configStatus").textContent = "Unable to contact server.";
  } finally {
    $("configSave").disabled = false;
  }
}

$("cancel").onclick = close;
$("confirm").onclick = pull;

$("modal").onclick = event => {
  if (event.target === $("modal")) {
    close();
  }
};

$("configButton").onclick = openConfig;
$("configCancel").onclick = closeConfig;
$("configSave").onclick = saveConfig;

$("configModal").onclick = event => {
  if (event.target === $("configModal")) {
    closeConfig();
  }
};

$("configPlayer").addEventListener("input", () => {
  configBaseFromServer = null;
});

$("configPlayer").addEventListener("change", () => {
  const player = $("configPlayer").value.trim();

  if (player) {
    loadPreference(player);
  }
});

load();
connect();
