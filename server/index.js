require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
const app = express();
if (process.env.TRUST_PROXY) {
  const proxySetting = process.env.TRUST_PROXY;
  app.set("trust proxy", proxySetting === "true" ? true : Number(proxySetting));
}
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const clients = new Set();
const radarReports = new Map();
const logs = [];
const pullTimers = new Map();

const CONTROLLER_TOKEN = process.env.STASIS_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const WS_PATH = "/ws";
const DEBUG = String(process.env.STASIS_DEBUG || "true").toLowerCase() === "true";

function debugLog(...args) {
  if (DEBUG) {
    console.log("[DEBUG]", ...args);
  }
}

const DATA_DIR = process.env.STASIS_DATA_DIR || path.join(ROOT, "data");
const PREFERENCES_FILE = path.join(DATA_DIR, "player-preferences.json");
const LOGS_FILE = path.join(DATA_DIR, "activity-logs.json");
const DISCORD_USERS_FILE = path.join(DATA_DIR, "discord-users.json");
const DISCORD_SESSIONS_FILE = path.join(DATA_DIR, "discord-sessions.json");
const PULL_API_TOKEN = process.env.PULL_API_TOKEN || process.env.STASIS_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || "";
const ACCESS_GUILD_ID = "1543358966300545116";
const REQUIRED_ROLE_ID = "1552640238168580167";
const AUTH_COOKIE = "stasis_session";
const sessions = new Map();
const oauthStates = new Map();
const refreshPromises = new WeakMap();
const roleCheckCache = new Map();
const roleCheckPromises = new Map();

try {
  const savedSessions = JSON.parse(fs.readFileSync(DISCORD_SESSIONS_FILE, "utf8"));
  for (const [tokenHash, session] of Object.entries(savedSessions)) {
    if (session?.expiresAt > Date.now() && session?.user?.id) sessions.set(tokenHash, session);
  }
} catch {
  // Sessions are created after the first successful Discord login.
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function saveSessions() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [key, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(key);
  }
  const temporary = DISCORD_SESSIONS_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(sessions), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, DISCORD_SESSIONS_FILE);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionUser(req) {
  return sessionFor(req)?.user || null;
}

function requireLogin(req, res, next) {
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error: "Log in with Discord to continue" });
  req.discordSession = session;
  req.discordUser = session.user;
  next();
}

function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  const key = token && sessionTokenHash(token);
  const session = key && sessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    if (key && sessions.delete(key)) saveSessions();
    return null;
  }
  return session;
}

async function refreshDiscordToken(session) {
  if (session.tokenExpiresAt > Date.now() + 60_000) return true;
  if (!session.refreshToken) return false;
  if (refreshPromises.has(session)) return refreshPromises.get(session);

  const refresh = (async () => {
    try {
      const response = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        console.warn("[Auth] Discord token refresh returned HTTP", response.status);
        return false;
      }
      const token = await response.json();
      session.accessToken = token.access_token;
      session.refreshToken = token.refresh_token || session.refreshToken;
      session.tokenExpiresAt = Date.now() + (Number(token.expires_in) || 604800) * 1000;
      saveSessions();
      return true;
    } catch (error) {
      console.error("[Auth] Discord token refresh failed:", error.message);
      return false;
    }
  })();

  refreshPromises.set(session, refresh);
  try {
    return await refresh;
  } finally {
    refreshPromises.delete(session);
  }
}

async function userHasRequiredRole(session) {
  if (!session?.accessToken || !session.user?.id) return false;
  const userId = String(session.user.id);
  const now = Date.now();
  const cached = roleCheckCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.allowed;
  if (roleCheckPromises.has(userId)) return roleCheckPromises.get(userId);

  const check = (async () => {
    await refreshDiscordToken(session);
    try {
      const response = await fetch(`https://discord.com/api/v10/users/@me/guilds/${ACCESS_GUILD_ID}/member`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(5000)
      });
      if (response.status === 429) {
        let retrySeconds = Number(response.headers.get("retry-after")) || 0;
        const body = await response.json().catch(() => ({}));
        retrySeconds = Math.max(retrySeconds, Number(body.retry_after) || 0);
        const retryAt = Date.now() + Math.min(Math.max(retrySeconds, 1), 900) * 1000;
        const allowed = cached?.allowed === true && cached.staleUntil > Date.now();
        roleCheckCache.set(userId, {
          allowed,
          expiresAt: retryAt,
          staleUntil: allowed ? cached.staleUntil : retryAt
        });
        console.warn(`[Auth] OAuth guild-member lookup rate limited; retrying in ${Math.ceil((retryAt - Date.now()) / 1000)}s`);
        return allowed;
      }

      if (!response.ok) {
        console.warn("[Auth] OAuth guild-member lookup returned HTTP", response.status);
      } else {
        const member = await response.json();
        if (Array.isArray(member.roles) && member.roles.includes(REQUIRED_ROLE_ID)) {
          roleCheckCache.set(userId, { allowed: true, expiresAt: Date.now() + 5 * 60 * 1000, staleUntil: Date.now() + 30 * 60 * 1000 });
          return true;
        }
      }
    } catch (error) {
      console.error("[Auth] OAuth guild role check failed:", error.message);
    }

    // Use the bot endpoint as a fallback when the user OAuth endpoint cannot confirm the role.
    const allowed = await botUserHasRequiredRole(userId);
    const checkedAt = Date.now();
    roleCheckCache.set(userId, {
      allowed,
      expiresAt: checkedAt + (allowed ? 5 * 60 * 1000 : 30 * 1000),
      staleUntil: checkedAt + (allowed ? 30 * 60 * 1000 : 30 * 1000)
    });
    return allowed;
  })();

  roleCheckPromises.set(userId, check);
  try {
    return await check;
  } finally {
    roleCheckPromises.delete(userId);
  }
}

async function requireGuildRole(req, res, next) {
  if (!(await userHasRequiredRole(req.discordSession))) {
    return res.status(403).json({ error: "Contact Dons via Discord" });
  }
  next();
}

function loginConfigured() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function loadDiscordUsers() {
  try {
    const value = JSON.parse(fs.readFileSync(DISCORD_USERS_FILE, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

let discordUsers = loadDiscordUsers();

function saveDiscordUser(discordProfile, ip) {
  const id = String(discordProfile.id);
  const previous = discordUsers[id] || {};
  const ips = [...new Set([...(previous.ips || []), ip].filter(Boolean))].slice(-20);
  discordUsers[id] = {
    discord: discordProfile,
    ips,
    createdAt: previous.createdAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = DISCORD_USERS_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(discordUsers, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, DISCORD_USERS_FILE);
}

function publicLog(entry) {
  return {
    ...entry,
    actor: String(entry.actor || "").replace(/\s*<[^<>]*@[^<>]*>/g, "").trim()
  };
}

function loadPreferences() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return JSON.parse(fs.readFileSync(PREFERENCES_FILE, "utf8"));
  } catch {
    return {};
  }
}

let playerPreferences = loadPreferences();

try {
  const savedLogs = JSON.parse(fs.readFileSync(LOGS_FILE, "utf8"));
  if (Array.isArray(savedLogs)) logs.push(...savedLogs.slice(0, 50));
} catch {
  // Activity history is created the first time the server records an event.
}

function savePreferences() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const tempFile = PREFERENCES_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(playerPreferences, null, 2) + "\n",
    "utf8"
  );

  fs.renameSync(tempFile, PREFERENCES_FILE);
}

function playerKey(player) {
  return String(player || "").trim().toLowerCase();
}

function defaultBaseForPlayer(player) {
  const value = playerPreferences[playerKey(player)]?.defaultBase;
  return Number.isInteger(Number(value)) ? Number(value) : null;
}

function chamberPreference(report) {
  const defaultBase = defaultBaseForPlayer(report.player);

  return {
    defaultBase,
    isDefaultChamber:
      defaultBase !== null &&
      Number(report.base) === Number(defaultBase)
  };
}

function findPlayerReports(player) {
  const wanted = playerKey(player);

  return [...collectReports().values()].filter(
    report =>
      playerKey(report.player) === wanted &&
      report.player &&
      report.status !== "empty"
  );
}

function resolvePlayerChamber(player, requestedBase = null) {
  const reports = findPlayerReports(player);

  if (!reports.length) {
    return {
      error: 404,
      message: "Player is not currently stored in a reported chamber"
    };
  }

  let base = Number(requestedBase);

  if (!Number.isInteger(base)) {
    const preferred = defaultBaseForPlayer(player);

    if (preferred !== null) {
      base = preferred;
    }
  }

  if (Number.isInteger(base)) {
    const matches = reports.filter(
      report => Number(report.base) === base
    );

    if (!matches.length) {
      const available = [...new Set(reports.map(report => report.base))]
        .sort((a, b) => Number(a) - Number(b));

      // When there is only one reported chamber for the player, use it as a
      // safe fallback even if an old/stale default base was saved. A saved
      // default becomes decisive again as soon as the player exists at
      // multiple bases.
      if (reports.length === 1) {
        return { report: reports[0], fallbackBase: true };
      }

      return {
        error: 409,
        message:
          "Player is not reported at their default base",
        availableBases: available,
        defaultBase: base
      };
    }

    if (matches.length > 1) {
      return {
        error: 409,
        message: "Player has multiple chambers at the selected base"
      };
    }

    return { report: matches[0] };
  }

  if (reports.length > 1) {
    return {
      error: 409,
      message:
        "Player is stored at multiple bases. Set a default base in the dashboard configuration.",
      availableBases: [...new Set(reports.map(report => report.base))]
        .sort((a, b) => Number(a) - Number(b))
    };
  }

  return { report: reports[0] };
}

function executePull(base, chamber, actor = "Unknown") {
  const key = chamberKey(base, chamber);
  const report = collectReports().get(key);

  if (!report) {
    return {
      error: 404,
      body: { error: "Chamber is not currently reported by ComputerCraft" }
    };
  }

  if (!report.player) {
    return {
      error: 409,
      body: { error: "This chamber has no player reported" }
    };
  }

  if (report.status === "pulling") {
    return {
      error: 409,
      body: { error: "This chamber is already being pulled" }
    };
  }

  const controller = controllerForChamber(base, chamber);

  if (!controller) {
    return {
      error: 503,
      body: { error: "No ComputerCraft controller connected for this base" }
    };
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
    return {
      error: 503,
      body: { error: "Controller connection lost" }
    };
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
    base,
    actor
  );

  return {
    ok: true,
    requestId,
    player: report.player,
    base,
    chamber
  };
}

if (!CONTROLLER_TOKEN) {
  console.error("Missing STASIS_TOKEN in .env");
  console.error("Create a .env file with STASIS_TOKEN=your-secret-token");
  process.exit(1);
}

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/auth/discord", (req, res) => {
  if (!loginConfigured()) return res.status(503).send("Discord login is not configured on this server.");
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify email guilds guilds.members.read");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const expires = oauthStates.get(state);
  oauthStates.delete(state);
  if (!loginConfigured() || !req.query.code || !expires || expires < Date.now() || req.query.error) {
    return res.redirect("/?login=failed");
  }
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: String(req.query.code), redirect_uri: DISCORD_REDIRECT_URI })
    });
    if (!tokenResponse.ok) throw new Error("Discord token exchange failed");
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
    if (!userResponse.ok) throw new Error("Discord identity lookup failed");
    const identity = await userResponse.json();
    saveDiscordUser(identity, clientIp(req));
    const user = {
      id: String(identity.id),
      username: identity.global_name || identity.username,
      avatar: identity.avatar || null
    };
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const session = {
      user,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tokenExpiresAt: Date.now() + (Number(token.expires_in) || 604800) * 1000,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    };
    sessions.set(sessionTokenHash(sessionToken), session);
    saveSessions();
    const secure = req.secure || req.get("x-forwarded-proto") === "https";
    res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`);
    res.redirect(await userHasRequiredRole(session) ? "/" : "/access-denied");
  } catch (error) {
    console.error("[Auth] Discord login failed:", error.message);
    res.redirect("/?login=failed");
  }
});

app.get("/api/auth", (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.json({ configured: loginConfigured(), user: null, allowed: false });
  const session = sessionFor(req);
  userHasRequiredRole(session).then(allowed => res.json({
    configured: loginConfigured(),
    user: { id: user.id, username: user.username, avatar: user.avatar },
    allowed
  })).catch(() => res.json({ configured: loginConfigured(), user: null, allowed: false }));
});
app.get("/access-denied", (_req, res) => res.sendFile(path.join(ROOT, "views", "access-denied.html")));
app.get("/radar", async (req, res) => {
  const session = sessionFor(req);
  if (!session) return res.redirect(loginConfigured() ? "/auth/discord" : "/");
  if (!(await userHasRequiredRole(session))) return res.redirect("/access-denied");
  res.sendFile(path.join(ROOT, "public", "radar.html"));
});
app.get("/logs", async (req, res) => {
  const session = sessionFor(req);
  if (!session) return res.redirect(loginConfigured() ? "/auth/discord" : "/");
  if (!(await userHasRequiredRole(session))) return res.redirect("/access-denied");
  res.sendFile(path.join(ROOT, "views", "logs.html"));
});
app.get("/api/logs", requireLogin, requireGuildRole, (req, res) => {
  const type = String(req.query.type || "").trim().toUpperCase();
  const actor = String(req.query.user || "").trim();
  const safeLogs = logs.map(publicLog);
  const entries = safeLogs.filter(entry =>
    (!type || String(entry.type || "").toUpperCase() === type) &&
    (!actor || entry.actor === actor)
  );
  res.json({
    logs: entries,
    types: [...new Set(safeLogs.map(entry => entry.type).filter(Boolean))].sort(),
    users: [...new Set(safeLogs.map(entry => entry.actor).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    currentUser: sessionUser(req).username
  });
});
app.post("/auth/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (token && sessions.delete(sessionTokenHash(token))) saveSessions();
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

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

function radarSnapshot() {
  const players = new Map();
  for (const report of radarReports.values()) {
    for (const player of report.players) {
      const key = player.username.toLowerCase();
      const previous = players.get(key);
      if (!previous || report.updatedAt > previous.updatedAt) players.set(key, { ...player, updatedAt: report.updatedAt });
    }
  }
  const reports = [...radarReports.values()];
  return {
    players: [...players.values()].sort((a, b) => a.username.localeCompare(b.username)),
    updatedAt: reports.length ? reports.reduce((latest, report) => Math.max(latest, report.updatedAt), 0) : null
  };
}

function broadcastRadar() {
  const message = { type: "radar", ...radarSnapshot() };
  for (const client of clients) if (client.role === "radar-browser") safeSend(client.ws, message);
}

function processRadarMessage(client, message) {
  if (message.type !== "radar" || !Array.isArray(message.players)) return;
  const players = [];
  for (const row of message.players) {
    const username = typeof row?.username === "string" ? row.username.trim() : "";
    const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z);
    if (!username || username.length > 32 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    players.push({ username, x, y, z, status: typeof row.status === "string" ? row.status : "unknown", floor: typeof row.floor === "string" ? row.floor : null, outOfBounds: Boolean(row.outOfBounds) });
  }
  radarReports.set(client.id, { players, updatedAt: Date.now() });
  broadcastRadar();
}

function addLog(type, chamber, player, detail, base, actor = "") {
  const entry = {
    time: new Date().toISOString(),
    type,
    chamber: chamber ?? null,
    player: player || "",
    detail: detail || "",
    base: base ?? null,
    actor: actor || ""
  };

  logs.unshift(entry);
  logs.splice(50);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOGS_FILE + ".tmp", JSON.stringify(logs, null, 2) + "\n", "utf8");
    fs.renameSync(LOGS_FILE + ".tmp", LOGS_FILE);
  } catch (error) {
    console.error("[Logs] Unable to persist activity history:", error.message);
  }

  // Activity history is served only through the role-protected /api/logs endpoint.
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

  if (DEBUG) {
    debugLog(
      "collectReports:",
      [...reports.values()].map(report => ({
        key: report.key,
        base: report.base,
        chamber: report.id,
        player: report.player,
        status: report.status,
        controller: report.sourceControllerName
      }))
    );
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
      reportedAt: report.updatedAt,
      ...chamberPreference(report)
    }));

  const result = {
    bases: baseList,
    chambers,
    logs: [],
    controllers: controllerClients().length,
    browsers: browserClients().length,
    playerCount: reportedPlayerCount(),
    controllerDetails: controllerClients().map(client => ({
      name: client.controllerName,
      base: client.base,
      baseName: client.baseName,
      connectedAt: client.connectedAt,
      lastHeartbeat: client.lastHeartbeat || null
    }))
  };

  if (DEBUG) {
    debugLog("snapshot:", JSON.stringify({
      bases: result.bases,
      chambers: result.chambers.map(chamber => ({
        key: chamber.key,
        base: chamber.base,
        id: chamber.id,
        player: chamber.player,
        status: chamber.status,
        controller: chamber.controller
      })),
      controllers: result.controllers,
      playerCount: result.playerCount
    }));
  }

  return result;
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
    baseName:
      (typeof input.baseName === "string" && input.baseName.trim()
        ? input.baseName.trim()
        : client.baseName) ||
      "Base " + client.base,
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

  debugLog(
    "chamber report received:",
    JSON.stringify({
      controller: client.controllerName,
      base: client.base,
      chamber,
      player,
      status,
      key
    })
  );

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
      reportedAt: effective.updatedAt,
      ...chamberPreference(effective)
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

  if (message.type === "heartbeat") {
    client.lastHeartbeat = Date.now();

    safeSend(client.ws, {
      type: "heartbeat-ack",
      id: message.id ?? null
    });

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
    setControllerIdentity(client, message);

    if (message.baseName) {
      client.baseName = String(message.baseName);
    }

    updateChamberFromController(client, message);
    broadcastSnapshot();
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
      setControllerIdentity(client, message);
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
    broadcastSnapshot();
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

app.get("/api/radar", (_req, res) => {
  res.json(radarSnapshot());
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    controllers: controllerClients().length,
    browsers: browserClients().length,
    playerCount: reportedPlayerCount()
  });
});

app.get("/api/preference", requireLogin, (req, res) => {
  const player = String(req.query.player || "").trim();

  if (!player) {
    return res.status(400).json({
      error: "player is required"
    });
  }

  res.json({
    player,
    defaultBase: defaultBaseForPlayer(player)
  });
});

app.post("/api/preference", requireLogin, (req, res) => {
  try {
    const player = String(req.body?.player || "").trim();
    const defaultBase = Number(req.body?.defaultBase);

    if (!player) {
      return res.status(400).json({
        error: "player is required"
      });
    }

    if (!Number.isInteger(defaultBase) || defaultBase < 0) {
      return res.status(400).json({
        error: "defaultBase must be a non-negative integer"
      });
    }

    const baseExists = getBaseInfo().has(defaultBase);

    if (!baseExists) {
      return res.status(404).json({
        error: "That base is not currently connected"
      });
    }

    playerPreferences[playerKey(player)] = {
      player,
      defaultBase,
      updatedAt: new Date().toISOString()
    };

    savePreferences();
    broadcastSnapshot();

    return res.json({
      ok: true,
      player,
      defaultBase
    });
  } catch (error) {
    console.error("[Preferences] save failed:", error);

    return res.status(500).json({
      error: "Unable to save player configuration",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/players", (_req, res) => {
  const players = [...collectReports().values()]
    .filter(report => report.player && report.status !== "empty")
    .map(report => report.player)
    .filter((player, index, all) =>
      all.findIndex(other => playerKey(other) === playerKey(player)) === index
    )
    .sort((a, b) => a.localeCompare(b));

  res.json({ players });
});

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

app.post("/api/pull", requireLogin, requireGuildRole, (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: "Log in with Discord to pull a pearl" });
  const base = Number(req.body && req.body.base);
  const chamber = Number(req.body && req.body.chamber);

  if (!Number.isInteger(base) || !Number.isInteger(chamber)) {
    return res.status(400).json({
      error: "base and chamber are required"
    });
  }

  const actor = `${user.username} (${user.id})`;
  const result = executePull(base, chamber, actor);

  if (result.error) {
    return res.status(result.error).json(result.body);
  }

  return res.json(result);
});

function authorizedComputerRequest(req) {
  const directToken = req.get("x-stasis-token");

  if (directToken && directToken === CONTROLLER_TOKEN) {
    return true;
  }

  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer\\s+(.+)$/i);

  return Boolean(
    match &&
    match[1] === CONTROLLER_TOKEN
  );
}

async function botUserHasRequiredRole(userId) {
  if (!DISCORD_BOT_TOKEN || !/^\d+$/.test(String(userId || ""))) return false;
  try {
    const response = await fetch(`https://discord.com/api/v10/guilds/${ACCESS_GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      console.warn("[Auth] Bot guild-member lookup returned HTTP", response.status,
        response.status === 404 ? "(check that this bot is in the configured Discord server)" : "");
      return false;
    }
    const member = await response.json();
    return Array.isArray(member.roles) && member.roles.includes(REQUIRED_ROLE_ID);
  } catch (error) {
    console.error("[Auth] Bot guild role check failed:", error.message);
    return false;
  }
}

async function handlePlayerPullRequest(req, res, requirePullToken = true) {
  if (
    requirePullToken
      ? !PULL_API_TOKEN || req.get("x-stasis-pull-token") !== PULL_API_TOKEN
      : !authorizedComputerRequest(req)
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  if (!(await botUserHasRequiredRole(req.body?.discordUserId))) {
    return res.status(403).json({ error: "Contact Dons via Discord" });
  }

  const player = String(req.body?.player || "").trim();
  const requestedBase =
    req.body?.base === undefined || req.body?.base === null
      ? null
      : Number(req.body.base);

  if (!player) {
    return res.status(400).json({
      error: "player is required"
    });
  }

  if (
    requestedBase !== null &&
    (!Number.isInteger(requestedBase) || requestedBase < 0)
  ) {
    return res.status(400).json({
      error: "base must be a non-negative integer"
    });
  }

  const resolved = resolvePlayerChamber(player, requestedBase);

  if (resolved.error) {
    return res.status(resolved.error).json({
      error: resolved.message,
      availableBases: resolved.availableBases || undefined,
      defaultBase: resolved.defaultBase ?? undefined
    });
  }

  const actor = req.body?.actor && typeof req.body.actor === "string" ? req.body.actor.slice(0, 100) : "Discord bot user";
  const result = executePull(
    resolved.report.base,
    resolved.report.id,
    actor
  );

  if (result.error) {
    return res.status(result.error).json(result.body);
  }

  return res.json({
    ...result,
    defaultUsed:
      requestedBase === null &&
      resolved.fallbackBase !== true &&
      defaultBaseForPlayer(player) !== null,
    fallbackBase: resolved.fallbackBase === true
  });
}

app.post("/api/pull-player", (req, res) => {
  return handlePlayerPullRequest(req, res, true);
});

app.post("/api/computer/pull", (req, res) => {
  return handlePlayerPullRequest(req, res, false);
});

function computerChamberList(req, res) {
  if (!authorizedComputerRequest(req)) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  const requestedBase =
    req.query?.base === undefined || req.query?.base === null || req.query.base === ""
      ? null
      : Number(req.query.base);

  const player = String(req.query?.player || "").trim();

  if (
    requestedBase !== null &&
    (!Number.isInteger(requestedBase) || requestedBase < 0)
  ) {
    return res.status(400).json({
      error: "base must be a non-negative integer"
    });
  }

  let chambers = [...collectReports().values()];

  if (requestedBase !== null) {
    chambers = chambers.filter(
      report => Number(report.base) === requestedBase
    );
  }

  if (player) {
    chambers = chambers.filter(
      report => playerKey(report.player) === playerKey(player)
    );

    // When asking for one player without an explicit base, prefer the
    // configured default base when it exists.
    if (requestedBase === null) {
      const preferred = defaultBaseForPlayer(player);

      if (preferred !== null) {
        const preferredMatches = chambers.filter(
          report => Number(report.base) === preferred
        );

        if (preferredMatches.length) {
          chambers = preferredMatches;
        }
      }
    }
  }

  chambers.sort((a, b) => {
    if (Number(a.base) !== Number(b.base)) {
      return Number(a.base) - Number(b.base);
    }

    return Number(a.id) - Number(b.id);
  });

  return res.json({
    chambers: chambers.map(report => ({
      key: report.key,
      chamber: report.id,
      base: report.base,
      baseName: report.baseName,
      label: report.label,
      player: report.player,
      status: report.status,
      controller: report.sourceControllerName,
      reportedAt: report.updatedAt,
      ...chamberPreference(report)
    })),
    count: chambers.length
  });
}

app.get("/api/computer/chambers", computerChamberList);


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

wss.on("connection", async (ws, request) => {
  const url = new URL(request.url, "http://localhost");

  debugLog("WebSocket connection:", url.pathname, url.search);

  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");
  const queryBase = url.searchParams.get("base");
  const queryName = url.searchParams.get("name");

  // The page is role-protected, and the socket must be too: otherwise a
  // direct WebSocket client could read radar positions without Discord access.
  if (role === "radar-browser") {
    const session = sessionFor(request);
    if (!session || !(await userHasRequiredRole(session))) {
      ws.close(1008, "Discord role required");
      return;
    }
  }

  if (role === "browser" || role === "radar-browser") {
    const client = {
      id: crypto.randomUUID(),
      ws,
      role,
      base: null,
      baseName: null,
      controllerName: null,
      reports: new Map()
    };

    clients.add(client);
    if (role === "browser") {
      safeSend(ws, { type: "state", state: snapshot() });
    } else {
      safeSend(ws, { type: "radar", ...radarSnapshot() });
    }

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", error => {
      console.error("[WS browser] error:", error.message);
    });

    return;
  }

  if (token !== CONTROLLER_TOKEN) {
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
    reports: new Map(),
    lastHeartbeat: Date.now()
  };

  if (role === "radar") {
    client.role = "radar";
    clients.add(client);
    ws.on("message", raw => {
      try {
        processRadarMessage(client, JSON.parse(raw.toString()));
      } catch {
        safeSend(ws, { type: "error", error: "Invalid JSON" });
      }
    });
    ws.on("close", () => {
      clients.delete(client);
      radarReports.delete(client.id);
      broadcastRadar();
    });
    ws.on("error", error => console.error("[WS radar] error:", error.message));
    return;
  }

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

    if (DEBUG && message.type !== "heartbeat") {
      debugLog(
        "controller message:",
        JSON.stringify({
          controller: client.controllerName,
          base: client.base,
          type: message.type,
          chamber: message.chamber,
          player: message.player,
          status: message.status,
          baseName: message.baseName,
          chambers: Array.isArray(message.chambers)
            ? message.chambers.length
            : undefined
        })
      );
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
