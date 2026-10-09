require("dotenv").config();

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { parseRegionName, readZipEntry, zipEntries, inspectRegionBuffer, mergeRegionBuffers, listRegionFiles, SUPPORTED_LAYERS } = require("./ftbchunks");

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

function writeAuthDebugLog(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      AUTH_DEBUG_LOG_FILE,
      JSON.stringify({ loggedAt: new Date().toISOString(), ...entry }) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    fs.chmodSync(AUTH_DEBUG_LOG_FILE, 0o600);
  } catch (error) {
    console.error("[Auth] Unable to write auth debug log:", error.message);
  }
}

const DATA_DIR = process.env.STASIS_DATA_DIR || path.join(ROOT, "data");
const AUTH_DEBUG_LOG_FILE = path.join(DATA_DIR, "auth-debug.log");
const PREFERENCES_FILE = path.join(DATA_DIR, "player-preferences.json");
const LOGS_FILE = path.join(DATA_DIR, "activity-logs.json");
const DISCORD_USERS_FILE = path.join(DATA_DIR, "discord-users.json");
const DISCORD_SESSIONS_FILE = path.join(DATA_DIR, "discord-sessions.json");
const SABLE_NAMES_FILE = path.join(DATA_DIR, "sable-names.json");
const RADAR_BUILDINGS_FILE = path.join(DATA_DIR, "radar-buildings.json");
const RADAR_ROADS_FILE = path.join(DATA_DIR, "radar-roads.json");
const FTB_CHUNKS_DIR = process.env.STASIS_FTBCHUNKS_DIR || path.join(DATA_DIR, "ftbchunks");
const PULL_API_TOKEN = process.env.PULL_API_TOKEN || process.env.STASIS_TOKEN || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN || "";
const ACCESS_GUILD_ID = "1543358966300545116";
const REQUIRED_ROLE_ID = "1552640238168580167";
const RADAR_VIEW_ROLE_ID = "1543368933464211456";
const TEST_ROLE_COOKIE = "stasis_test_role";
const TEST_USER_ID = "000000000000000000";
const TEST_USER_NAME = "Local Test";
const AUTH_COOKIE = "stasis_session";
const sessions = new Map();
const oauthStates = new Map();
const refreshPromises = new WeakMap();
const roleCheckCache = new Map();
const roleCheckPromises = new Map();
const radarRoleCheckCache = new Map();
const radarRoleCheckPromises = new Map();

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

function isLoopbackRequest(req) {
  const host = String(req.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const remote = String(req.socket?.remoteAddress || "")
    .replace(/^::ffff:/i, "")
    .toLowerCase();

  return (
    ["localhost", "127.0.0.1", "::1"].includes(host) &&
    ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1"].includes(remote)
  );
}

function setLocalTestRoleCookie(req, res, role) {
  if (!isLoopbackRequest(req)) return;

  if (!role || role === "off") {
    res.setHeader("Set-Cookie", TEST_ROLE_COOKIE + "=; Path=/; SameSite=Lax; Max-Age=0");
    return;
  }

  res.setHeader(
    "Set-Cookie",
    TEST_ROLE_COOKIE + "=" + encodeURIComponent(role) + "; Path=/; SameSite=Lax; Max-Age=3600"
  );
}

function getLocalTestRole(req) {
  if (!isLoopbackRequest(req)) return null;

  const requested = String(req.query?.testRole || "").trim().toLowerCase();
  if (requested === "off") {
    setLocalTestRoleCookie(req, req.res, "off");
    return null;
  }

  const allowed = new Set(["full", "viewer", "denied"]);
  if (allowed.has(requested)) {
    setLocalTestRoleCookie(req, req.res, requested);
    return requested;
  }

  const cookies = parseCookies(req.headers.cookie);
  const cookieRole = String(cookies[TEST_ROLE_COOKIE] || "").trim().toLowerCase();
  return allowed.has(cookieRole) ? cookieRole : null;
}

function localTestSession(req) {
  const role = getLocalTestRole(req);
  if (!role) return null;

  return {
    testRole: role,
    user: {
      id: TEST_USER_ID,
      username: TEST_USER_NAME,
      avatar: null
    }
  };
}

function requestSession(req) {
  return localTestSession(req) || sessionFor(req);
}

function sessionUser(req) {
  return requestSession(req)?.user || null;
}

function requireLogin(req, res, next) {
  const session = requestSession(req);
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
  if (session?.testRole) return session.testRole === "full";
  if (!session?.user?.id) return false;
  const userId = String(session.user.id);
  if (hasRememberedRole(userId)) return true;
  if (!session.accessToken) return false;
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
          rememberVerifiedRole(session.user);
          return true;
        }
      }
    } catch (error) {
      console.error("[Auth] OAuth guild role check failed:", error.message);
    }

    // Use the bot endpoint as a fallback when the user OAuth endpoint cannot confirm the role.
    const allowed = await botUserHasRole(userId, REQUIRED_ROLE_ID);
    const checkedAt = Date.now();
    roleCheckCache.set(userId, {
      allowed,
      expiresAt: checkedAt + (allowed ? 5 * 60 * 1000 : 30 * 1000),
      staleUntil: checkedAt + (allowed ? 30 * 60 * 1000 : 30 * 1000)
    });
    if (allowed) rememberVerifiedRole(session.user);
    return allowed;
  })();

  roleCheckPromises.set(userId, check);
  try {
    return await check;
  } finally {
    roleCheckPromises.delete(userId);
  }
}

async function userHasRadarRole(session) {
  if (session?.testRole) return session.testRole === "full" || session.testRole === "viewer";
  if (!session?.user?.id) return false;
  const userId = String(session.user.id);

  if (hasRememberedRole(userId)) return true;

  const now = Date.now();
  const cached = radarRoleCheckCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.allowed;
  if (!session.accessToken) return false;
  if (radarRoleCheckPromises.has(userId)) return radarRoleCheckPromises.get(userId);

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
        radarRoleCheckCache.set(userId, {
          allowed,
          expiresAt: retryAt,
          staleUntil: allowed ? cached.staleUntil : retryAt
        });
        console.warn(`[Auth] OAuth radar-role lookup rate limited; retrying in ${Math.ceil((retryAt - Date.now()) / 1000)}s`);
        return allowed;
      }

      if (response.ok) {
        const member = await response.json();
        if (Array.isArray(member.roles) && member.roles.includes(RADAR_VIEW_ROLE_ID)) {
          const checkedAt = Date.now();
          radarRoleCheckCache.set(userId, {
            allowed: true,
            expiresAt: checkedAt + 5 * 60 * 1000,
            staleUntil: checkedAt + 30 * 60 * 1000
          });
          return true;
        }
      } else {
        console.warn("[Auth] OAuth radar-role lookup returned HTTP", response.status);
      }
    } catch (error) {
      console.error("[Auth] OAuth radar-role lookup failed:", error.message);
    }

    const allowed = await botUserHasRole(userId, RADAR_VIEW_ROLE_ID);
    const checkedAt = Date.now();
    radarRoleCheckCache.set(userId, {
      allowed,
      expiresAt: checkedAt + (allowed ? 5 * 60 * 1000 : 30 * 1000),
      staleUntil: checkedAt + (allowed ? 30 * 60 * 1000 : 30 * 1000)
    });
    return allowed;
  })();

  radarRoleCheckPromises.set(userId, check);
  try {
    return await check;
  } finally {
    radarRoleCheckPromises.delete(userId);
  }
}

let discordRoleNameCache = { expiresAt: 0, names: {} };

async function discordRoleNames() {
  const now = Date.now();
  if (discordRoleNameCache.expiresAt > now) return discordRoleNameCache.names;

  const names = {
    [REQUIRED_ROLE_ID]: "Stasis Control access",
    [RADAR_VIEW_ROLE_ID]: "Radar viewer"
  };

  if (DISCORD_BOT_TOKEN) {
    try {
      const response = await fetch(
        `https://discord.com/api/v10/guilds/${ACCESS_GUILD_ID}/roles`,
        {
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (response.ok) {
        const roles = await response.json();
        for (const role of roles) {
          if (role?.id && role?.name) names[String(role.id)] = String(role.name);
        }
      }
    } catch (error) {
      console.warn("[Auth] Unable to load Discord role names:", error.message);
    }
  }

  discordRoleNameCache = { expiresAt: now + 10 * 60 * 1000, names };
  return names;
}

async function diagnoseDiscordAccess(session) {
  const user = session?.user || null;
  const base = {
    authenticated: Boolean(user?.id),
    username: user?.username || null,
    discordId: user?.id ? String(user.id) : null,
    guildId: ACCESS_GUILD_ID,
    requiredRoleId: REQUIRED_ROLE_ID,
    radarViewerRoleId: RADAR_VIEW_ROLE_ID,
    checkedAt: new Date().toISOString()
  };

  if (!user?.id) {
    return {
      ...base,
      testSession: false,
      guildMember: null,
      lookupSource: "none",
      lookupStatus: null,
      roles: null,
      requiredRoleDetected: null,
      radarViewerDetected: null,
      dashboardAccess: false,
      radarAccess: false,
      reason: "No active Discord session. Log in with Discord first."
    };
  }

  if (session.testRole) {
    const ids = session.testRole === "full"
      ? [REQUIRED_ROLE_ID, RADAR_VIEW_ROLE_ID]
      : session.testRole === "viewer"
        ? [RADAR_VIEW_ROLE_ID]
        : [];
    const names = await discordRoleNames();
    return {
      ...base,
      testSession: true,
      testRole: session.testRole,
      guildMember: null,
      guildMembership: "Simulated local test session",
      lookupSource: "local test mode",
      lookupStatus: null,
      roles: ids.map(id => ({ id, name: names[id] || "Role" })),
      requiredRoleDetected: ids.includes(REQUIRED_ROLE_ID),
      radarViewerDetected: ids.includes(RADAR_VIEW_ROLE_ID),
      dashboardAccess: session.testRole === "full",
      radarAccess: session.testRole === "full" || session.testRole === "viewer",
      reason: "This is simulated localhost test data; no Discord lookup was performed."
    };
  }

  const errors = [];
  let member = null;
  let lookupSource = "none";
  let lookupStatus = null;
  let oauthStatus = null;
  let botStatus = null;

  if (await refreshDiscordToken(session) && session.accessToken) {
    try {
      const response = await fetch(
        `https://discord.com/api/v10/users/@me/guilds/${ACCESS_GUILD_ID}/member`,
        {
          headers: { Authorization: `Bearer ${session.accessToken}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      oauthStatus = response.status;
      if (response.ok) {
        member = await response.json();
        lookupSource = "Discord OAuth";
        lookupStatus = response.status;
      } else {
        errors.push("OAuth member lookup returned HTTP " + response.status);
      }
    } catch (error) {
      errors.push("OAuth member lookup failed: " + error.message);
    }
  } else {
    errors.push("Discord OAuth access token could not be refreshed");
  }

  if (!member && DISCORD_BOT_TOKEN) {
    try {
      const response = await fetch(
        `https://discord.com/api/v10/guilds/${ACCESS_GUILD_ID}/members/${encodeURIComponent(String(user.id))}`,
        {
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      botStatus = response.status;
      if (response.ok) {
        member = await response.json();
        lookupSource = "Discord bot";
        lookupStatus = response.status;
      } else {
        errors.push("Bot member lookup returned HTTP " + response.status);
      }
    } catch (error) {
      errors.push("Bot member lookup failed: " + error.message);
    }
  }

  const roleNames = await discordRoleNames();
  const roleIds = Array.isArray(member?.roles)
    ? member.roles.map(id => String(id))
    : null;
  const roles = roleIds
    ? roleIds.map(id => ({ id, name: roleNames[id] || "Unknown role" }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : null;
  const requiredRoleDetected = roleIds ? roleIds.includes(REQUIRED_ROLE_ID) : null;
  const radarViewerDetected = roleIds ? roleIds.includes(RADAR_VIEW_ROLE_ID) : null;
  const guildMember = member
    ? true
    : (oauthStatus === 404 || botStatus === 404 ? false : null);

  let dashboardAccess = null;
  let radarAccess = null;
  try {
    [dashboardAccess, radarAccess] = await Promise.all([
      userHasRequiredRole(session),
      userHasRadarRole(session)
    ]);
  } catch (error) {
    errors.push("Application role check failed: " + error.message);
  }

  let reason;
  if (guildMember === false) reason = "Account was not found as a member of the configured Discord server.";
  else if (requiredRoleDetected === false && radarViewerDetected === false) reason = "Neither configured access role was found on the Discord member.";
  else if (requiredRoleDetected === false && radarViewerDetected === true) reason = "Radar viewer role detected, but the Stasis Control access role is missing.";
  else if (requiredRoleDetected === true) reason = "Stasis Control access role detected.";
  else if (guildMember === null) reason = "Discord could not confirm guild membership or role assignments.";
  else reason = "Discord member data was returned; review the detected roles and access checks.";

  return {
    ...base,
    testSession: false,
    guildMember,
    guildMembership: guildMember === true ? "Yes" : guildMember === false ? "No" : "Unable to verify",
    lookupSource,
    lookupStatus,
    oauthStatus,
    botStatus,
    roles,
    requiredRoleDetected,
    radarViewerDetected,
    dashboardAccess,
    radarAccess,
    rememberedRole: hasRememberedRole(user.id),
    reason,
    errors
  };
}

async function requireRadarRole(req, res, next) {
  if (!(await userHasRadarRole(req.discordSession))) {
    return res.status(403).json({ error: "You need the radar viewer role to access Stasis Radar" });
  }
  next();
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

function persistDiscordUsers() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = DISCORD_USERS_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(discordUsers, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, DISCORD_USERS_FILE);
}

function hasRememberedRole(userId) {
  return Boolean(discordUsers[String(userId)]?.roleVerifiedAt);
}

function rememberVerifiedRole(user) {
  const id = String(user.id);
  const previous = discordUsers[id] || {};
  discordUsers[id] = {
    ...previous,
    discord: previous.discord || { id, username: user.username || "Unknown" },
    roleVerifiedAt: previous.roleVerifiedAt || new Date().toISOString()
  };
  persistDiscordUsers();
}

function saveDiscordUser(discordProfile, ip) {
  const id = String(discordProfile.id);
  const previous = discordUsers[id] || {};
  const ips = [...new Set([...(previous.ips || []), ip].filter(Boolean))].slice(-20);
  discordUsers[id] = {
    ...previous,
    discord: discordProfile,
    ips,
    createdAt: previous.createdAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
  persistDiscordUsers();
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

function loadSableNames() {
  try {
    const value = JSON.parse(fs.readFileSync(SABLE_NAMES_FILE, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadRadarBuildings() {
  try {
    const value = JSON.parse(fs.readFileSync(RADAR_BUILDINGS_FILE, "utf8"));
    return Array.isArray(value) ? value.map(normalizeRadarBuilding).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeRadarBuilding(building) {
  if (!building || typeof building.id !== "string" || typeof building.name !== "string") return null;
  const x1 = Number.isFinite(building.x1) ? Math.round(building.x1) : building.x;
  const z1 = Number.isFinite(building.z1) ? Math.round(building.z1) : building.z;
  const x2 = Number.isFinite(building.x2) ? Math.round(building.x2) : x1;
  const z2 = Number.isFinite(building.z2) ? Math.round(building.z2) : z1;
  return Number.isFinite(x1) && Number.isFinite(z1) && Number.isFinite(x2) && Number.isFinite(z2)
    ? { id: building.id, name: building.name, x1, z1, x2, z2 }
    : null;
}

function loadRadarRoads() {
  try {
    const value = JSON.parse(fs.readFileSync(RADAR_ROADS_FILE, "utf8"));
    return Array.isArray(value) ? value.map(normalizeRadarRoad).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeRadarRoad(road) {
  if (!road || typeof road.id !== "string") return null;
  const { x1, z1, x2, z2 } = road;
  return [x1, z1, x2, z2].every(Number.isFinite)
    ? { id: road.id, x1: Math.round(x1), z1: Math.round(z1), x2: Math.round(x2), z2: Math.round(z2) }
    : null;
}

let sableNames = loadSableNames();
let radarBuildings = loadRadarBuildings();
let radarRoads = loadRadarRoads();

function sanitizeFtbDimension(value) {
  const dimension = String(value || "minecraft:overworld").trim();
  if (!dimension || dimension.length > 128 || !/^[a-zA-Z0-9_.:-]+$/.test(dimension)) {
    return null;
  }
  return dimension;
}

function ftbDimensionKey(dimension) {
  return dimension.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function ftbDimensionDirectory(dimension) {
  const safeDimension = sanitizeFtbDimension(dimension);
  if (!safeDimension) return null;
  return path.join(FTB_CHUNKS_DIR, ftbDimensionKey(safeDimension));
}

function ftbRegionFile(dimension, regionName) {
  const directory = ftbDimensionDirectory(dimension);
  const region = parseRegionName(regionName);
  if (!directory || !region) return null;
  return path.join(directory, region.name + ".zip");
}

function listFtbRegions(dimension) {
  const directory = ftbDimensionDirectory(dimension);
  if (!directory) return [];
  return listRegionFiles(directory).map(region => ({
    name: region.name,
    x: region.x,
    z: region.z,
    version: region.version,
    chunkCount: region.chunks.length,
    size: region.size
  })).sort((a, b) => a.z - b.z || a.x - b.x);
}

function saveSableNames() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = SABLE_NAMES_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(sableNames, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, SABLE_NAMES_FILE);
}

function saveRadarBuildings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = RADAR_BUILDINGS_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(radarBuildings, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, RADAR_BUILDINGS_FILE);
}

function saveRadarRoads() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = RADAR_ROADS_FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(radarRoads, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, RADAR_ROADS_FILE);
}

function sableDisplayName(id) {
  const key = String(id || "").trim();
  const value = typeof sableNames[key] === "string" ? sableNames[key].trim() : "";
  return value || null;
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

app.get("/api/radar/ftbchunks", requireLogin, requireRadarRole, (req, res) => {
  const dimension = sanitizeFtbDimension(req.query.dimension || "minecraft:overworld");
  if (!dimension) return res.status(400).json({ error: "Invalid FTB Chunks dimension" });
  res.json({
    dimension,
    regionSize: 512,
    regionChunks: 32,
    regions: listFtbRegions(dimension)
  });
});

app.post(
  "/api/radar/ftbchunks/import",
  requireLogin,
  requireGuildRole,
  express.raw({ type: "*/*", limit: "20mb" }),
  (req, res) => {
    const dimension = sanitizeFtbDimension(req.query.dimension || "minecraft:overworld");
    const requestedRegion = req.query.region || req.get("x-ftbchunks-region") || "";
    const region = parseRegionName(requestedRegion);

    if (!dimension) return res.status(400).json({ error: "Invalid FTB Chunks dimension" });
    if (!region) return res.status(400).json({ error: "Invalid FTB Chunks region name" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "A non-empty FTB Chunks region ZIP is required" });
    }

    try {
      const info = inspectRegionBuffer(req.body, region.name);
      const directory = ftbDimensionDirectory(dimension);
      fs.mkdirSync(directory, { recursive: true });
      const file = ftbRegionFile(dimension, region.name);

      let output = req.body;
      let merge = {
        merged: false,
        added: info.chunks.length,
        updated: 0,
        skippedOlder: 0,
        incomingChunks: info.chunks.length,
        finalChunks: info.chunks.length
      };

      if (fs.existsSync(file)) {
        const existing = fs.readFileSync(file);
        const result = mergeRegionBuffers(existing, req.body, region.name);
        output = result.buffer;
        merge = {
          merged: true,
          added: result.added,
          updated: result.updated,
          skippedOlder: result.skippedOlder,
          incomingChunks: result.incomingChunks,
          finalChunks: result.finalChunks
        };
      }

      const temporary = file + ".tmp";
      fs.writeFileSync(temporary, output, { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);

      const finalInfo = inspectRegionBuffer(output, region.name);

      res.json({
        ok: true,
        dimension,
        region: {
          name: finalInfo.name,
          x: finalInfo.x,
          z: finalInfo.z,
          version: finalInfo.version,
          chunkCount: finalInfo.chunks.length,
          size: output.length
        },
        merge
      });
    } catch (error) {
      console.error("[Radar] FTB Chunks import failed:", error.message);
      return res.status(400).json({ error: error.message || "Invalid FTB Chunks region ZIP" });
    }
  }
);

app.delete("/api/radar/ftbchunks/region/:region", requireLogin, requireGuildRole, (req, res) => {
  const dimension = sanitizeFtbDimension(req.query.dimension || "minecraft:overworld");
  const region = parseRegionName(req.params.region);
  const file = dimension && region ? ftbRegionFile(dimension, region.name) : null;

  if (!file) return res.status(400).json({ error: "Invalid FTB Chunks region" });
  if (!fs.existsSync(file)) return res.status(404).json({ error: "FTB Chunks region not found" });

  try {
    fs.unlinkSync(file);
    res.json({ ok: true });
  } catch (error) {
    console.error("[Radar] FTB Chunks region removal failed:", error.message);
    res.status(500).json({ error: "Unable to remove FTB Chunks region" });
  }
});

app.get("/api/radar/ftbchunks/region/:region/:layer", requireLogin, requireRadarRole, (req, res) => {
  const dimension = sanitizeFtbDimension(req.query.dimension || "minecraft:overworld");
  const region = parseRegionName(req.params.region);
  const layer = String(req.params.layer || "") + ".png";
  const file = dimension && region ? ftbRegionFile(dimension, region.name) : null;

  if (!file || !SUPPORTED_LAYERS.has(layer)) {
    return res.status(400).json({ error: "Invalid FTB Chunks region or image layer" });
  }
  if (!fs.existsSync(file)) return res.status(404).send("FTB Chunks region not found");

  try {
    const archive = fs.readFileSync(file);
    const entries = zipEntries(archive);
    const image = readZipEntry(archive, entries, layer);
    if (!image) return res.status(404).send("FTB Chunks image layer not found");

    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("png").send(image);
  } catch (error) {
    console.error("[Radar] FTB Chunks image read failed:", error.message);
    res.status(500).send("Unable to read FTB Chunks image");
  }
});



async function sendDashboardPage(req, res) {
  const session = requestSession(req);
  if (!session) return res.redirect(loginConfigured() ? "/auth/discord" : "/access-denied");
  if (session.testRole === "viewer") return res.redirect("/radar?testRole=viewer");
  if (session.testRole === "denied") return res.redirect("/access-denied?testRole=denied");
  if (!(await userHasRequiredRole(session))) return res.redirect("/access-denied");
  res.sendFile(path.join(ROOT, "public", "index.html"));
}

// Register these before the static middleware so neither / nor /index.html
// can bypass the remembered Discord-role authorization.
app.get("/", sendDashboardPage);
app.get("/index.html", sendDashboardPage);
app.get("/radar.html", (_req, res) => res.redirect("/radar"));
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
    const fullAccess = await userHasRequiredRole(session);
    if (fullAccess) return res.redirect("/");
    if (await userHasRadarRole(session)) return res.redirect("/radar");
    return res.redirect("/access-denied");
  } catch (error) {
    console.error("[Auth] Discord login failed:", error.message);
    res.redirect("/access-denied?login=failed");
  }
});

app.get("/api/auth/debug", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session = requestSession(req);
  let diagnostic;
  try {
    diagnostic = await diagnoseDiscordAccess(session);
  } catch (error) {
    diagnostic = {
      authenticated: Boolean(session?.user?.id),
      username: session?.user?.username || null,
      discordId: session?.user?.id ? String(session.user.id) : null,
      guildId: ACCESS_GUILD_ID,
      requiredRoleId: REQUIRED_ROLE_ID,
      radarViewerRoleId: RADAR_VIEW_ROLE_ID,
      guildMember: null,
      guildMembership: "Unable to verify",
      lookupSource: "error",
      roles: null,
      requiredRoleDetected: null,
      radarViewerDetected: null,
      dashboardAccess: null,
      radarAccess: null,
      reason: "Unable to retrieve Discord diagnostics.",
      errors: [error.message]
    };
  }

  writeAuthDebugLog({
    event: "access-denied-diagnostics",
    ip: clientIp(req),
    path: req.originalUrl || req.path,
    user: diagnostic.username,
    discordId: diagnostic.discordId,
    guildId: diagnostic.guildId,
    guildMember: diagnostic.guildMember,
    lookupSource: diagnostic.lookupSource,
    lookupStatus: diagnostic.lookupStatus,
    roleIds: Array.isArray(diagnostic.roles) ? diagnostic.roles.map(role => role.id) : null,
    roles: diagnostic.roles,
    requiredRoleDetected: diagnostic.requiredRoleDetected,
    radarViewerDetected: diagnostic.radarViewerDetected,
    dashboardAccess: diagnostic.dashboardAccess,
    radarAccess: diagnostic.radarAccess,
    rememberedRole: diagnostic.rememberedRole || false,
    reason: diagnostic.reason,
    errors: diagnostic.errors || []
  });

  res.json(diagnostic);
});

app.get("/api/auth", (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.json({ configured: loginConfigured(), user: null, allowed: false, radarAllowed: false, radarCanModify: false });
  const session = requestSession(req);
  Promise.all([userHasRequiredRole(session), userHasRadarRole(session)]).then(([allowed, radarAllowed]) => res.json({
    configured: loginConfigured(),
    user: { id: user.id, username: user.username, avatar: user.avatar },
    allowed,
    radarAllowed,
    radarCanModify: allowed
  })).catch(() => res.json({ configured: loginConfigured(), user: null, allowed: false, radarAllowed: false, radarCanModify: false }));
});
app.get("/access-denied", (_req, res) => res.sendFile(path.join(ROOT, "views", "access-denied.html")));
app.get("/radar", async (req, res) => {
  const session = requestSession(req);
  if (!session) return res.redirect(loginConfigured() ? "/auth/discord" : "/");
  if (session.testRole === "denied") return res.redirect("/access-denied?testRole=denied");
  if (!(await userHasRadarRole(session))) return res.redirect("/access-denied");
  res.sendFile(path.join(ROOT, "public", "radar.html"));
});
app.get("/logs", async (req, res) => {
  const session = requestSession(req);
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

  if (isLoopbackRequest(req)) {
    res.setHeader("Set-Cookie", [
      AUTH_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      TEST_ROLE_COOKIE + "=; Path=/; SameSite=Lax; Max-Age=0"
    ]);
  } else {
    res.setHeader("Set-Cookie", AUTH_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  }

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
  const sableContraptions = new Map();

  for (const report of radarReports.values()) {
    for (const player of report.players || []) {
      const key = player.username.toLowerCase();
      const previous = players.get(key);
      if (!previous || report.updatedAt > previous.updatedAt) {
        players.set(key, { ...player, updatedAt: report.updatedAt });
      }
    }

    for (const sable of report.sableContraptions || []) {
      const key = sable.id
        ? "id:" + sable.id
        : "anonymous:" + [sable.x, sable.y, sable.z].join(":");
      const previous = sableContraptions.get(key);
      if (!previous || report.updatedAt > previous.updatedAt) {
        sableContraptions.set(key, { ...sable, updatedAt: report.updatedAt });
      }
    }
  }

  const reports = [...radarReports.values()];
  const sortedSables = [...sableContraptions.values()].sort((a, b) =>
    (a.id || "").localeCompare(b.id || "")
  );

  const numberedSables = sortedSables.map((sable, index) => ({
    ...sable,
    number: index + 1,
    name: sableDisplayName(sable.id)
  }));

  return {
    players: [...players.values()].sort((a, b) => a.username.localeCompare(b.username)),
    sableContraptions: numberedSables,
    buildings: [...radarBuildings].sort((a, b) => a.name.localeCompare(b.name)),
    roads: [...radarRoads],
    updatedAt: reports.length
      ? reports.reduce((latest, report) => Math.max(latest, report.updatedAt), 0)
      : null
  };
}

function broadcastRadar() {
  const message = { type: "radar", ...radarSnapshot() };
  for (const client of clients) {
    if (client.role === "radar-browser") safeSend(client.ws, message);
  }
}

function processRadarMessage(client, message) {
  if (
    message.type !== "radar" ||
    (!Array.isArray(message.players) && !Array.isArray(message.sableContraptions))
  ) return;

  const players = [];
  for (const row of message.players || []) {
    const username = typeof row?.username === "string" ? row.username.trim() : "";
    const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z);
    if (!username || username.length > 32 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    players.push({
      username, x, y, z,
      status: typeof row.status === "string" ? row.status : "unknown",
      floor: typeof row.floor === "string" ? row.floor : null,
      outOfBounds: Boolean(row.outOfBounds)
    });
  }

  const sableContraptions = [];
  for (const row of message.sableContraptions || []) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    sableContraptions.push({
      id,
      category: "SABLE",
      x,
      y,
      z,
      entityType: typeof row.entityType === "string" ? row.entityType : null
    });
  }

  radarReports.set(client.id, {
    players,
    sableContraptions,
    updatedAt: Date.now()
  });
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

app.get("/api/radar", requireLogin, requireRadarRole, (_req, res) => {
  res.json(radarSnapshot());
});

app.get("/api/radar/sable-names", requireLogin, requireRadarRole, (req, res) => {
  const names = {};
  for (const [id, name] of Object.entries(sableNames)) {
    if (typeof id === "string" && typeof name === "string" && name.trim()) {
      names[id] = name.trim();
    }
  }
  res.json({ names });
});

app.post("/api/radar/sable-name", requireLogin, requireGuildRole, (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

  if (!id || id.length > 128) {
    return res.status(400).json({ error: "Invalid SABLE id" });
  }

  if (name.length > 40) {
    return res.status(400).json({ error: "SABLE name must be 40 characters or fewer" });
  }

  if (name) {
    sableNames[id] = name;
  } else {
    delete sableNames[id];
  }

  try {
    saveSableNames();
  } catch (error) {
    console.error("[Radar] Unable to save SABLE names:", error.message);
    return res.status(500).json({ error: "Unable to save SABLE name" });
  }

  broadcastRadar();
  res.json({
    ok: true,
    id,
    name: sableDisplayName(id)
  });
});

app.post("/api/radar/building", requireLogin, requireGuildRole, (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const x1 = Math.round(Number(req.body?.x1));
  const z1 = Math.round(Number(req.body?.z1));
  const x2 = Math.round(Number(req.body?.x2));
  const z2 = Math.round(Number(req.body?.z2));

  if (!name || name.length > 40 || ![x1, z1, x2, z2].every(Number.isFinite)) {
    return res.status(400).json({ error: "Building name and two finite X/Z corners are required" });
  }

  const building = { id: id || crypto.randomUUID(), name, x1, z1, x2, z2 };
  const existingIndex = id ? radarBuildings.findIndex(item => item.id === id) : -1;
  if (existingIndex >= 0) radarBuildings[existingIndex] = building;
  else radarBuildings.push(building);

  try {
    saveRadarBuildings();
  } catch (error) {
    console.error("[Radar] Unable to save buildings:", error.message);
    return res.status(500).json({ error: "Unable to save building" });
  }

  broadcastRadar();
  res.json({ ok: true, building });
});

app.delete("/api/radar/building/:id", requireLogin, requireGuildRole, (req, res) => {
  const id = String(req.params.id || "").trim();
  const nextBuildings = radarBuildings.filter(building => building.id !== id);
  if (nextBuildings.length === radarBuildings.length) return res.status(404).json({ error: "Building not found" });
  radarBuildings = nextBuildings;

  try {
    saveRadarBuildings();
  } catch (error) {
    console.error("[Radar] Unable to save buildings:", error.message);
    return res.status(500).json({ error: "Unable to save building" });
  }

  broadcastRadar();
  res.json({ ok: true });
});

app.post("/api/radar/road", requireLogin, requireGuildRole, (req, res) => {
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const x1 = Math.round(Number(req.body?.x1));
  const z1 = Math.round(Number(req.body?.z1));
  const x2 = Math.round(Number(req.body?.x2));
  const z2 = Math.round(Number(req.body?.z2));

  if (![x1, z1, x2, z2].every(Number.isFinite)) {
    return res.status(400).json({ error: "Two finite X/Z corners are required" });
  }

  const road = { id: id || crypto.randomUUID(), x1, z1, x2, z2 };
  const existingIndex = id ? radarRoads.findIndex(item => item.id === id) : -1;
  if (existingIndex >= 0) radarRoads[existingIndex] = road;
  else radarRoads.push(road);

  try {
    saveRadarRoads();
  } catch (error) {
    console.error("[Radar] Unable to save roads:", error.message);
    return res.status(500).json({ error: "Unable to save road" });
  }

  broadcastRadar();
  res.json({ ok: true, road });
});

app.delete("/api/radar/road/:id", requireLogin, requireGuildRole, (req, res) => {
  const id = String(req.params.id || "").trim();
  const nextRoads = radarRoads.filter(road => road.id !== id);
  if (nextRoads.length === radarRoads.length) return res.status(404).json({ error: "Road not found" });
  radarRoads = nextRoads;

  try {
    saveRadarRoads();
  } catch (error) {
    console.error("[Radar] Unable to save roads:", error.message);
    return res.status(500).json({ error: "Unable to save road" });
  }

  broadcastRadar();
  res.json({ ok: true });
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

async function botUserHasRole(userId, roleId) {
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
    return Array.isArray(member.roles) && member.roles.includes(String(roleId));
  } catch (error) {
    console.error("[Auth] Bot guild role check failed:", error.message);
    return false;
  }
}

async function botUserHasRequiredRole(userId) {
  return botUserHasRole(userId, REQUIRED_ROLE_ID);
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

  // Browser dashboards are role-protected, and their sockets must be too:
  // otherwise a direct WebSocket client could read dashboard data without
  // Discord access.
  if (role === "browser" || role === "radar-browser") {
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

app.use(sendDashboardPage);

server.listen(PORT, "0.0.0.0", () => {
  console.log("Stasis Control running on port " + PORT);
  console.log("WebSocket path: " + WS_PATH);
});
