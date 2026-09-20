require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "chambers.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const clients = new Set();
const logs = [];
const statuses = new Map();

const CONTROLLER_TOKEN = process.env.STASIS_TOKEN;
const PORT = Number(process.env.PORT || config.server.port);

if (!CONTROLLER_TOKEN) {
  console.error("Missing STASIS_TOKEN in .env");
  console.error("Create a .env file with STASIS_TOKEN=your-secret-token");
  process.exit(1);
}

for (const chamber of config.chambers) {
  statuses.set(chamber.id, {
    status: chamber.player ? "ready" : "empty",
    player: chamber.player || ""
  });
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public")));

function safeSend(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const client of clients) safeSend(client.ws, message);
}

function controllerCount() {
  return [...clients].filter(client => client.role === "controller").length;
}

function browserCount() {
  return [...clients].filter(client => client.role === "browser").length;
}

function addLog(type, chamber, player, detail) {
  const entry = { time: new Date().toISOString(), type, chamber, player, detail: detail || "" };
  logs.unshift(entry);
  logs.splice(50);
  broadcast({ type: "log", entry });
}

function chamberById(id) {
  return config.chambers.find(chamber => chamber.id === id);
}

function snapshot() {
  return {
    bases: config.bases,
    chambers: config.chambers.map(chamber => ({ ...chamber, ...(statuses.get(chamber.id) || {}) })),
    logs,
    controllers: controllerCount(),
    browsers: browserCount()
  };
}

app.get("/api/state", (_req, res) => res.json(snapshot()));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, controllers: controllerCount(), browsers: browserCount() });
});

app.post("/api/pull", (req, res) => {
  const chamberId = Number(req.body && req.body.chamber);
  const chamber = chamberById(chamberId);

  if (!Number.isInteger(chamberId) || !chamber) {
    return res.status(404).json({ error: "Unknown chamber" });
  }

  const state = statuses.get(chamberId);
  if (!state || !state.player) {
    return res.status(409).json({ error: "This chamber has no player assigned" });
  }

  if (state.status === "pulling") {
    return res.status(409).json({ error: "This chamber is already being pulled" });
  }

  const controllers = [...clients].filter(client => client.role === "controller");
  if (!controllers.length) {
    return res.status(503).json({ error: "No ComputerCraft controller connected" });
  }

  const requestId = crypto.randomUUID();
  const command = { type: "pull", chamber: chamberId, player: state.player, requestId };
  controllers.forEach(client => safeSend(client.ws, command));

  statuses.set(chamberId, { ...state, status: "pulling" });
  broadcast({ type: "chamber", chamber: chamberId, state: statuses.get(chamberId) });
  addLog("PULL", chamberId, state.player, "Command sent to ComputerCraft");

  res.json({ ok: true, requestId });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname !== config.server.wsPath) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, "http://localhost");
  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");
  const controllerName = url.searchParams.get("name") || "controller";

  const authorized = role === "browser" || (role === "controller" && token === CONTROLLER_TOKEN);
  if (!authorized) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const client = { ws, role, controllerName };
  clients.add(client);

  safeSend(ws, { type: "state", state: snapshot() });
  broadcast({ type: "connections", controllers: controllerCount(), browsers: browserCount() });

  ws.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (client.role !== "controller" || message.type !== "status") return;

    const chamberId = Number(message.chamber);
    const chamber = chamberById(chamberId);
    if (!chamber) return;

    const current = statuses.get(chamberId) || { player: chamber.player || "", status: "empty" };
    const next = {
      player: typeof message.player === "string" ? message.player : current.player || "",
      status: typeof message.status === "string" ? message.status : current.status || "empty"
    };

    statuses.set(chamberId, next);
    broadcast({ type: "chamber", chamber: chamberId, state: next });

    if (message.status === "pulled") addLog("DONE", chamberId, next.player, "Pearl pulled");
    else if (message.status === "ready") addLog("READY", chamberId, next.player, "Chamber ready");
  });

  ws.on("close", () => {
    clients.delete(client);
    broadcast({ type: "connections", controllers: controllerCount(), browsers: browserCount() });
  });

  ws.on("error", error => console.error("[WS] error:", error.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Stasis Control running on http://0.0.0.0:" + PORT);
});
