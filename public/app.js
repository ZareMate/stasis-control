let state = null;
let socket = null;
let pending = null;
let timer = null;

const $ = id => document.getElementById(id);

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

function toast(message) {
  const element = $("toast");

  element.textContent = message;
  element.classList.remove("hidden");

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.add("hidden");
  }, 3500);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("cancel").onclick = close;
$("confirm").onclick = pull;

$("modal").onclick = event => {
  if (event.target === $("modal")) {
    close();
  }
};

load();
connect();
