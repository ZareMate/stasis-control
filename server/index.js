require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "chambers.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const clients = new Set();
const logs = [];
const statuses = new Map();
const pullTimers = new Map();

const CONTROLLER_TOKEN = process.env.STASIS_TOKEN;
const PORT = Number(process.env.PORT || config.server.port);

if (!CONTROLLER_TOKEN) {
  console.error("Missing STASIS_TOKEN in .env");
  console.error("Create a .env file with STASIS_TOKEN=your-secret-token");
  process.exit(1);
}

for (const chamber of config.chambers) {
  statuses.set(chamber.id, {
    status: "empty",
    player: "",
    controller: null,
    reported: false
  });
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public")));

function safeSend(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function broadcast(message) {
  for (const client of clients) safeSend(client.ws, message);
}

function controllers() {
  return [...clients].filter(client => client.role === "controller");
}

function controllerCount() {
  return controllers().length;
}

function browserCount() {
  return [...clients].filter(client => client.role === "browser").length;
}

function reportedPlayerCount() {
  return config.bases.reduce((total, base) => {
    return total + config.chambers.filter(chamber => {
      if (!base.chambers.includes(chamber.id)) return false;

      const current = statuses.get(chamber.id);
      if (!current || !current.reported) return false;

      return (
        typeof current.player === "string" &&
        current.player.trim() !== "" &&
        ["ready", "pulling", "pulled"].includes(current.status)
      );
    }).length;
  }, 0);
}
function addLog(type, chamber, player, detail) {
  const entry = {
    time: new Date().toISOString(),
    type,
    chamber,
    player,
    detail: detail || ""
  };

  logs.unshift(entry);
  logs.splice(50);
  broadcast({ type: "log", entry });
}

function chamberById(id) {
  return config.chambers.find(chamber => chamber.id === Number(id));
}

function baseByChamber(chamberId) {
  return config.bases.find(base =>
    base.chambers.includes(Number(chamberId))
  );
}

function chamberByPlayer(player, baseId) {
  const value = String(player || "").trim().toLowerCase();
  if (!value) return null;

  const base = config.bases.find(b => b.id === Number(baseId));
  if (!base) return null;

  return config.chambers.find(chamber =>
    base.chambers.includes(chamber.id) &&
    String(chamber.player || "").trim().toLowerCase() === value
  );
}

function controllerForChamber(chamberId) {
  const base = baseByChamber(chamberId);
  if (!base) return null;

  const current = statuses.get(chamberId);

  if (current?.controller) {
    const owner = controllers().find(
      client =>
        client.base === base.id &&
        client.controllerName === current.controller
    );

    if (owner) return owner;
  }

  return controllers().find(client => client.base === base.id) || null;
}

function snapshot() {
  return {
    bases: config.bases,
    chambers: config.chambers.map(chamber => ({
      ...chamber,
      ...(statuses.get(chamber.id) || {})
    })),
    logs,
    controllers: controllerCount(),
    browsers: browserCount(),
    playerCount: reportedPlayerCount(),
    controllerDetails: controllers().map(client => ({
      name: client.controllerName,
      base: client.base,
      connectedAt: client.connectedAt
    }))
  };
}

function broadcastSnapshot() {
  broadcast({ type: "state", state: snapshot() });
}

function clearPullTimer(chamberId) {
  const timer = pullTimers.get(chamberId);
  if (timer) clearTimeout(timer);
  pullTimers.delete(chamberId);
}

function markControllerOffline(baseId) {
  for (const chamber of config.chambers) {
    const base = baseByChamber(chamber.id);
    if (!base || base.id !== baseId) continue;

    const current = statuses.get(chamber.id) || {
      player: chamber.player || "",
      status: "empty"
    };

    clearPullTimer(chamber.id);

    statuses.set(chamber.id, {
      ...current,
      player: current.player || chamber.player || "",
      status: "offline",
      controller: null
    });
  }
}

function markControllerOnline(baseId, controllerName) {
  for (const chamber of config.chambers) {
    const base = baseByChamber(chamber.id);
    if (!base || base.id !== baseId) continue;

    const current = statuses.get(chamber.id);
    if (!current) continue;

    // Preserve the most recent chamber report. The reporting controller
    // identifies which controller owns that chamber.
    statuses.set(chamber.id, {
      ...current
    });
  }
}
function updateChamberFromController(client, input) {
  let chamberId = Number.isInteger(Number(input.chamber))
    ? Number(input.chamber)
    : null;

  let chamber = chamberId ? chamberById(chamberId) : null;

  if (!chamber && input.player) {
    chamber = chamberByPlayer(input.player, client.base);
    if (chamber) chamberId = chamber.id;
  }

  if (!chamber) {
    console.warn(
      "[WS] Ignoring status: chamber could not be resolved",
      input
    );
    return;
  }

  const base = baseByChamber(chamber.id);
  if (!base || base.id !== client.base) {
    console.warn(
      "[WS] Ignoring status from controller " +
      client.controllerName +
      " for chamber " +
      chamber.id +
      " outside its base"
    );
    return;
  }

  const current = statuses.get(chamber.id) || {};
  const nextStatus = String(input.status || current.status || "empty");

  const next = {
    player:
      nextStatus === "empty"
        ? ""
        : typeof input.player === "string" && input.player.trim()
          ? input.player.trim()
          : current.player || chamber.player || "",
    status: ["empty", "ready", "pulling", "pulled"].includes(nextStatus)
      ? nextStatus
      : current.status || "empty",
    controller: client.controllerName,
    reported: true
  };

  statuses.set(chamber.id, next);

  if (next.status === "ready") {
    clearPullTimer(chamber.id);
  } else if (next.status === "pulled") {
    clearPullTimer(chamber.id);

    // Keep the chamber in PULLED state briefly so the dashboard can show
    // that the pearl was just pulled, then return it to READY automatically.
    pullTimers.set(
      chamber.id,
      setTimeout(() => {
        const current = statuses.get(chamber.id);

        if (!current || current.status !== "pulled") return;

        const ready = {
          ...current,
          status: "ready"
        };

        statuses.set(chamber.id, ready);

        broadcast({
          type: "chamber",
          chamber: chamber.id,
          state: ready
        });
      }, 5000)
    );
  }

  broadcast({
    type: "chamber",
    chamber: chamber.id,
    state: next
  });

  if (next.status === "pulled") {
    addLog("DONE", chamber.id, next.player, "Pearl pulled");
  } else if (next.status === "ready") {
    addLog("READY", chamber.id, next.player, "Chamber ready");
  }
}

function processControllerMessage(client, message) {
  if (message.type === "status") {
    updateChamberFromController(client, message);
    return;
  }

  if (
    message.type === "stasis" ||
    message.type === "stasis-data" ||
    message.type === "state"
  ) {
    if (Array.isArray(message.chambers)) {
      for (const chamber of message.chambers) {
        updateChamberFromController(client, chamber);
      }
    }
  }
}
app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    controllers: controllerCount(),
    browsers: browserCount()
  });
});

app.post("/api/pull", (req, res) => {
  const chamberId = Number(req.body && req.body.chamber);
  const chamber = chamberById(chamberId);

  if (!Number.isInteger(chamberId) || !chamber) {
    return res.status(404).json({ error: "Unknown chamber" });
  }

  const base = baseByChamber(chamberId);
  if (!base) {
    return res.status(500).json({ error: "Chamber has no configured base" });
  }

  const state = statuses.get(chamberId);
  if (!state || !state.player) {
    return res.status(409).json({
      error: "This chamber has no player assigned"
    });
  }

  if (state.status === "pulling") {
    return res.status(409).json({
      error: "This chamber is already being pulled"
    });
  }

  const controller = controllerForChamber(chamberId);

  if (!controller) {
    return res.status(503).json({
      error: base.name + " controller is offline"
    });
  }

  const requestId = crypto.randomUUID();

  const command = {
    type: "pull",
    base: base.id,
    chamber: chamberId,
    player: state.player,
    requestId
  };

  if (!safeSend(controller.ws, command)) {
    return res.status(503).json({
      error: "Controller connection lost"
    });
  }

  statuses.set(chamberId, {
    ...state,
    status: "pulling",
    controller: controller.controllerName
  });

  clearPullTimer(chamberId);

  pullTimers.set(
    chamberId,
    setTimeout(() => {
      const current = statuses.get(chamberId);
      if (!current || current.status !== "pulling") return;

      statuses.set(chamberId, {
        ...current,
        status: "ready"
      });

      addLog(
        "TIMEOUT",
        chamberId,
        current.player,
        "Controller did not report the pull result"
      );

      broadcast({
        type: "chamber",
        chamber: chamberId,
        state: statuses.get(chamberId)
      });
    }, 15000)
  );

  broadcast({
    type: "chamber",
    chamber: chamberId,
    state: statuses.get(chamberId)
  });

  addLog(
    "PULL",
    chamberId,
    state.player,
    base.name + " / " + controller.controllerName
  );

  res.json({ ok: true, requestId });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname !== config.server.wsPath) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(
    request,
    socket,
    head,
    ws => wss.emit("connection", ws, request)
  );
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, "http://localhost");

  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");
  const controllerName =
    url.searchParams.get("name") || "controller";

  if (role === "browser") {
    const client = {
      ws,
      role: "browser",
      controllerName: null,
      base: null,
      connectedAt: new Date().toISOString()
    };

    clients.add(client);
    safeSend(ws, { type: "state", state: snapshot() });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", error =>
      console.error("[WS browser] error:", error.message)
    );

    return;
  }

  if (role !== "controller" || token !== CONTROLLER_TOKEN) {
    ws.close(1008, "Unauthorized");
    return;
  }

  let baseId = Number(url.searchParams.get("base"));

  // Backwards compatibility with controller names like "base-1".
  if (!Number.isInteger(baseId)) {
    const match = controllerName.match(/base[-_ ]?(\d+)/i);
    if (match) baseId = Number(match[1]);
  }

  const base = config.bases.find(item => item.id === baseId);

  if (!base) {
    ws.close(1008, "Unknown base");
    return;
  }

  const client = {
    ws,
    role: "controller",
    controllerName,
    base: base.id,
    connectedAt: new Date().toISOString()
  };

  clients.add(client);
  markControllerOnline(base.id, controllerName);

  safeSend(ws, {
    type: "state",
    state: snapshot()
  });

  addLog(
    "CONNECT",
    null,
    null,
    controllerName + " connected to " + base.name
  );
  broadcastSnapshot();

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, {
        type: "error",
        error: "Invalid JSON"
      });
      return;
    }

    processControllerMessage(client, message);
  });

  ws.on("close", () => {
    clients.delete(client);

    const stillConnected = controllers().some(
      current => current.base === client.base
    );

    if (!stillConnected) {
      markControllerOffline(client.base);
      addLog(
        "DISCONNECT",
        null,
        null,
        client.controllerName + " disconnected from " + base.name
      );
      broadcastSnapshot();
    } else {
      broadcast({
        type: "connections",
        controllers: controllerCount(),
        browsers: browserCount()
      });
      broadcastSnapshot();
    }
  });

  ws.on("error", error =>
    console.error("[WS controller] error:", error.message)
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Stasis Control running on http://0.0.0.0:" + PORT
  );
  console.log(
    "WebSocket path: " + config.server.wsPath
  );
});
