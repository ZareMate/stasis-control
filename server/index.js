require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const clients = new Set();
const logs = [];
const pullTimers = new Map();

const CONTROLLER_TOKEN = process.env.STASIS_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WS_PATH = "/ws";

if (!CONTROLLER_TOKEN) {
  console.error("Missing STASIS_TOKEN in .env");
  console.error("Create a .env file with STASIS_TOKEN=your-secret-token");
  process.exit(1);
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
  for (const client of clients) {
    safeSend(client.ws, message);
  }
}

function controllerClients() {
  return [...clients].filter(
    client => client.role === "controller" && client.base !== null
  );
}

function browserClients() {
  return [...clients].filter(client => client.role === "browser");
}

function addLog(type, chamber, player, detail, base) {
  const entry = {
    time: new Date().toISOString(),
    type,
    chamber: chamber ?? null,
    player: player || "",
    detail: detail || "",
    base: base ?? null
  };

  logs.unshift(entry);
  logs.splice(50);

  broadcast({ type: "log", entry });
}

function chamberKey(base, chamber) {
  return String(base) + ":" + String(chamber);
}

function normalizeStatus(status) {
  const value = String(status || "empty").toLowerCase();

  return ["empty", "ready", "pulling", "pulled"].includes(value)
    ? value
    : "empty";
}

function setControllerIdentity(client, input = {}) {
  const baseValue = input.base ?? input.baseId ?? client.base;
  const base = Number(baseValue);

  if (Number.isInteger(base) && base >= 0) {
    client.base = base;
  }

  if (
    typeof input.baseName === "string" &&
    input.baseName.trim()
  ) {
    client.baseName = input.baseName.trim();
  } else if (
    typeof input.base_name === "string" &&
    input.base_name.trim()
  ) {
    client.baseName = input.base_name.trim();
  } else if (client.base !== null && !client.baseName) {
    client.baseName = "Base " + client.base;
  }

  if (
    typeof input.controller === "string" &&
    input.controller.trim()
  ) {
    client.controllerName = input.controller.trim();
  } else if (
    typeof input.name === "string" &&
    input.name.trim()
  ) {
    client.controllerName = input.name.trim();
  } else if (!client.controllerName) {
    client.controllerName =
      client.base !== null
        ? "base-" + client.base
        : "controller-" + client.id.slice(0, 8);
  }

  return client.base !== null;
}

function unwrapChambers(message) {
  if (Array.isArray(message.chambers)) return message.chambers;
  if (Array.isArray(message.data)) return message.data;
  if (Array.isArray(message.stasis)) return message.stasis;
  if (message.data && Array.isArray(message.data.chambers)) {
    return message.data.chambers;
  }
  if (message.stasis && Array.isArray(message.stasis.chambers)) {
    return message.stasis.chambers;
  }

  return null;
}

function collectReports() {
  const reports = new Map();

  for (const client of controllerClients()) {
    for (const [key, report] of client.reports) {
      const existing = reports.get(key);

      if (!existing || report.updatedAt > existing.updatedAt) {
        reports.set(key, report);
      }
    }
  }

  return reports;
}

function getBaseInfo() {
  const bases = new Map();

  for (const client of controllerClients()) {
    const id = client.base;

    if (!bases.has(id)) {
      bases.set(id, {
        id,
        name: client.baseName || "Base " + id,
        chambers: []
      });
    }
  }

  for (const report of collectReports().values()) {
    if (!bases.has(report.base)) {
      bases.set(report.base, {
        id: report.base,
        name: report.baseName || "Base " + report.base,
        chambers: []
      });
    }
  }

  return bases;
}

function reportedPlayerCount() {
  let count = 0;

  for (const report of collectReports().values()) {
    if (
      report.player &&
      ["ready", "pulling", "pulled"].includes(report.status)
    ) {
      count++;
    }
  }

  return count;
}

function snapshot() {
  const reports = collectReports();
  const bases = getBaseInfo();

  for (const report of reports.values()) {
    const base = bases.get(report.base);

    if (base && !base.chambers.includes(report.key)) {
      base.chambers.push(report.key);
    }
  }

  const baseList = [...bases.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(base => ({
      ...base,
      chambers: base.chambers.sort((a, b) => {
        const an = Number(String(a).split(":")[1]);
        const bn = Number(String(b).split(":")[1]);
        return an - bn;
      })
    }));

  const chambers = [...reports.values()]
    .sort((a, b) => {
      if (Number(a.base) !== Number(b.base)) {
        return Number(a.base) - Number(b.base);
      }

      return Number(a.id) - Number(b.id);
    })
    .map(report => ({
      key: report.key,
      id: report.id,
      base: report.base,
      baseName: report.baseName,
      label: report.label,
      player: report.player,
      status: report.status,
      controller: report.sourceControllerName,
      reportedAt: report.updatedAt
    }));

  return {
    bases: baseList,
    chambers,
    logs,
    controllers: controllerClients().length,
    browsers: browserClients().length,
    playerCount: reportedPlayerCount(),
    controllerDetails: controllerClients().map(client => ({
      name: client.controllerName,
      base: client.base,
      baseName: client.baseName,
      connectedAt: client.connectedAt
    }))
  };
}

function broadcastSnapshot() {
  broadcast({
    type: "state",
    state: snapshot()
  });
}

function clearPullTimer(key) {
  const timer = pullTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    pullTimers.delete(key);
  }
}

function resetPulledChamber(key) {
  clearPullTimer(key);

  pullTimers.set(
    key,
    setTimeout(() => {
      const reports = collectReports();
      const current = reports.get(key);

      if (!current || current.status !== "pulled") {
        return;
      }

      for (const client of controllerClients()) {
        const report = client.reports.get(key);

        if (report && report.status === "pulled") {
          client.reports.set(key, {
            ...report,
            status: "ready",
            updatedAt: new Date().toISOString()
          });
        }
      }

      broadcast({
        type: "chamber",
        chamber: key,
        state: {
          ...current,
          status: "ready"
        },
        playerCount: reportedPlayerCount()
      });
    }, 5000)
  );
}

function updateChamberFromController(client, input) {
  if (client.base === null) {
    console.warn(
      "[WS] Ignoring chamber report before controller registration"
    );
    return;
  }

  const chamber = Number(input && input.chamber);

  if (!Number.isInteger(chamber) || chamber < 0) {
    console.warn("[WS] Invalid chamber report:", input);
    return;
  }

  if (
    input.base !== undefined &&
    Number(input.base) !== Number(client.base)
  ) {
    console.warn(
      "[WS] Ignoring report for another base from " +
      client.controllerName
    );
    return;
  }

  const key = chamberKey(client.base, chamber);
  const status = normalizeStatus(input.status);
  const previous = client.reports.get(key);

  const player =
    status === "empty"
      ? ""
      : typeof input.player === "string" && input.player.trim()
        ? input.player.trim()
        : previous?.player || "";

  const report = {
    key,
    id: chamber,
    base: client.base,
    baseName: client.baseName || "Base " + client.base,
    label:
      typeof input.label === "string" && input.label.trim()
        ? input.label.trim()
        : previous?.label || "Chamber " + String(chamber).padStart(2, "0"),
    player,
    status,
    sourceControllerId: client.id,
    sourceControllerName: client.controllerName,
    updatedAt: Date.now()
  };

  client.reports.set(key, report);

  if (status === "ready") {
    clearPullTimer(key);
  }

  if (status === "pulled") {
    resetPulledChamber(key);
  }

  const effective = collectReports().get(key);

  if (!effective) {
    broadcastSnapshot();
    return;
  }

  broadcast({
    type: "chamber",
    chamber: key,
    state: {
      key: effective.key,
      id: effective.id,
      base: effective.base,
      baseName: effective.baseName,
      label: effective.label,
      player: effective.player,
      status: effective.status,
      controller: effective.sourceControllerName,
      reportedAt: effective.updatedAt
    },
    playerCount: reportedPlayerCount()
  });

  if (status === "pulled") {
    addLog(
      "DONE",
      chamber,
      player,
      "Pearl pulled",
      client.base
    );
  } else if (status === "ready") {
    addLog(
      "READY",
      chamber,
      player,
      "Chamber ready",
      client.base
    );
  }
}

function processControllerMessage(client, message) {
  if (!message || typeof message !== "object") {
    return;
  }

  // Controllers may identify themselves either in the WebSocket query string
  // or inside the first status/stasis message. This keeps the protocol fully
  // WebSocket-driven while remaining compatible with older controllers.
  if (message.type === "register") {
    if (!setControllerIdentity(client, message)) {
      safeSend(client.ws, {
        type: "error",
        error: "Invalid base in registration"
      });
      return;
    }

    safeSend(client.ws, {
      type: "registered",
      controller: client.controllerName,
      base: client.base,
      baseName: client.baseName
    });

    addLog(
      "CONNECT",
      null,
      null,
      client.controllerName + " connected to " + client.baseName,
      client.base
    );

    broadcastSnapshot();
    return;
  }

  // Infer identity from any incoming message that carries base information.
  setControllerIdentity(client, message);

  if (client.base === null) {
    safeSend(client.ws, {
      type: "error",
      error: "Controller base is unknown; include base in the WebSocket data"
    });
    return;
  }

  if (message.type === "status") {
    updateChamberFromController(client, message);
    return;
  }

  const chamberList = unwrapChambers(message);

  if (
    message.type === "stasis" ||
    message.type === "stasis-data" ||
    message.type === "state" ||
    chamberList
  ) {
    if (chamberList) {
      for (const chamber of chamberList) {
        // A chamber entry may carry its own base/controller metadata.
        if (chamber && typeof chamber === "object") {
          updateChamberFromController(
            client,
            {
              ...chamber,
              base:
                chamber.base ??
                chamber.baseId ??
                message.base ??
                message.baseId ??
                client.base
            }
          );
        }
      }

      broadcastSnapshot();
    }

    return;
  }

  if (message.type === "pull-result") {
    const chamber = Number(message.chamber);
    const key = chamberKey(client.base, chamber);

    if (message.success) {
      addLog(
        "DONE",
        chamber,
        typeof message.player === "string" ? message.player : "",
        "Pull command completed",
        client.base
      );
    } else {
      addLog(
        "ERROR",
        chamber,
        typeof message.player === "string" ? message.player : "",
        message.error || "Pull command failed",
        client.base
      );
    }

    clearPullTimer(key);
  }
}

function controllerForChamber(base, chamber) {
  const key = chamberKey(base, chamber);
  const reports = collectReports();
  const report = reports.get(key);

  if (report) {
    const owner = controllerClients().find(
      client => client.id === report.sourceControllerId
    );

    if (owner) {
      return owner;
    }
  }

  return (
    controllerClients().find(
      client => Number(client.base) === Number(base)
    ) || null
  );
}

app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    controllers: controllerClients().length,
    browsers: browserClients().length,
    playerCount: reportedPlayerCount()
  });
});

app.post("/api/pull", (req, res) => {
  const base = Number(req.body && req.body.base);
  const chamber = Number(req.body && req.body.chamber);

  if (!Number.isInteger(base) || !Number.isInteger(chamber)) {
    return res.status(400).json({
      error: "base and chamber are required"
    });
  }

  const key = chamberKey(base, chamber);
  const report = collectReports().get(key);

  if (!report) {
    return res.status(404).json({
      error: "Chamber is not currently reported by ComputerCraft"
    });
  }

  if (!report.player) {
    return res.status(409).json({
      error: "This chamber has no player reported"
    });
  }

  if (report.status === "pulling") {
    return res.status(409).json({
      error: "This chamber is already being pulled"
    });
  }

  const controller = controllerForChamber(base, chamber);

  if (!controller) {
    return res.status(503).json({
      error: "No ComputerCraft controller connected for this base"
    });
  }

  const requestId = crypto.randomUUID();

  const command = {
    type: "pull",
    base,
    chamber,
    player: report.player,
    requestId
  };

  if (!safeSend(controller.ws, command)) {
    return res.status(503).json({
      error: "Controller connection lost"
    });
  }

  const sourceReport = controller.reports.get(key) || report;

  controller.reports.set(key, {
    ...sourceReport,
    status: "pulling",
    updatedAt: Date.now()
  });

  clearPullTimer(key);

  pullTimers.set(
    key,
    setTimeout(() => {
      const current = collectReports().get(key);

      if (!current || current.status !== "pulling") {
        return;
      }

      for (const client of controllerClients()) {
        const currentReport = client.reports.get(key);

        if (currentReport && currentReport.status === "pulling") {
          client.reports.set(key, {
            ...currentReport,
            status: "ready",
            updatedAt: Date.now()
          });
        }
      }

      broadcast({
        type: "chamber",
        chamber: key,
        state: {
          ...current,
          status: "ready"
        },
        playerCount: reportedPlayerCount()
      });
    }, 15000)
  );

  const effective = collectReports().get(key);

  broadcast({
    type: "chamber",
    chamber: key,
    state: {
      ...effective,
      controller: controller.controllerName
    },
    playerCount: reportedPlayerCount()
  });

  addLog(
    "PULL",
    chamber,
    report.player,
    controller.baseName + " / " + controller.controllerName,
    base
  );

  res.json({
    ok: true,
    requestId
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname !== WS_PATH) {
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
  const queryBase = url.searchParams.get("base");
  const queryName = url.searchParams.get("name");

  if (role === "browser") {
    const client = {
      id: crypto.randomUUID(),
      ws,
      role: "browser",
      base: null,
      baseName: null,
      controllerName: null,
      reports: new Map()
    };

    clients.add(client);
    safeSend(ws, {
      type: "state",
      state: snapshot()
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", error => {
      console.error("[WS browser] error:", error.message);
    });

    return;
  }

  if (role === "browser") {
    // handled above
  } else if (token !== CONTROLLER_TOKEN) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const client = {
    id: crypto.randomUUID(),
    ws,
    role: "controller",
    base: null,
    baseName: null,
    controllerName: null,
    reports: new Map()
  };

  setControllerIdentity(client, {
    base: queryBase,
    name: queryName
  });

  clients.add(client);

  // A controller with base information in its WebSocket URL is immediately
  // visible as connected, even before its first chamber report arrives.
  if (client.base !== null) {
    broadcastSnapshot();
  }

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

    for (const key of client.reports.keys()) {
      clearPullTimer(key);
    }

    if (client.base !== null) {
      addLog(
        "DISCONNECT",
        null,
        null,
        (client.controllerName || "controller") +
          " disconnected from " +
          (client.baseName || "Base " + client.base),
        client.base
      );

      broadcastSnapshot();
    }
  });

  ws.on("error", error => {
    console.error("[WS controller] error:", error.message);
  });
});

app.use((req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Stasis Control running on port " + PORT);
  console.log("WebSocket path: " + WS_PATH);
});
