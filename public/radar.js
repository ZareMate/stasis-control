const map = document.getElementById("radarMap");
const list = document.getElementById("playerList");
const empty = document.getElementById("radarEmpty");
const dot = document.getElementById("dot");
const connection = document.getElementById("connectionText");
const meta = document.getElementById("radarMeta");
const coordinates = document.getElementById("radarCoordinates");
let socket, reconnectTimer, players = [];
let view = { x: -111, z: 243, scale: 2 };
let drag = null;

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function statusFor(player) { const status = String(player.status || "unknown").toLowerCase(); return ["enemy", "ally", "team", "unknown"].includes(status) ? status : "unknown"; }
function renderMap() {
  const { width, height } = map.getBoundingClientRect();
  if (!width || !height) return;
  map.querySelectorAll(".radar-player").forEach(node => node.remove());
  empty.hidden = players.length > 0;
  const grid = Math.max(12, 10 * view.scale);
  const offsetX = width / 2 - ((view.x * view.scale) % grid);
  const offsetZ = height / 2 - ((view.z * view.scale) % grid);
  map.style.backgroundSize = `${grid}px ${grid}px,${grid}px ${grid}px,${grid * 5}px ${grid * 5}px,${grid * 5}px ${grid * 5}px`;
  map.style.backgroundPosition = `${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px`;
  coordinates.textContent = `X ${Math.round(view.x)} · Z ${Math.round(view.z)} · ${view.scale.toFixed(1)} px/block`;
  for (const player of players) {
    const point = document.createElement("div");
    const status = statusFor(player);
    point.className = "radar-player " + status;
    point.style.left = (width / 2 + (player.x - view.x) * view.scale) + "px";
    point.style.top = (height / 2 + (player.z - view.z) * view.scale) + "px";
    point.title = `${player.username}: X ${player.x}, Y ${player.y}, Z ${player.z} (${status})`;
    point.innerHTML = `<span>${escapeHtml(player.username)}</span>`;
    map.append(point);
  }
}
function render(nextPlayers, updatedAt) {
  players = nextPlayers;
  renderMap();
  list.innerHTML = players.length ? players.map(player => {
    const status = statusFor(player);
    return `<div class="radar-row ${status}"><strong><i></i>${escapeHtml(player.username)}</strong><span>${status.toUpperCase()} · X ${Math.round(player.x)} · Y ${Math.round(player.y)} · Z ${Math.round(player.z)}${player.floor ? " · " + escapeHtml(player.floor) : ""}</span></div>`;
  }).join("") : '<div class="empty-log">No players detected.</div>';
  meta.textContent = `${players.length} player${players.length === 1 ? "" : "s"}${updatedAt ? " · updated " + new Date(updatedAt).toLocaleTimeString() : ""}`;
}
function worldAt(clientX, clientY) { const bounds = map.getBoundingClientRect(); return { x: view.x + (clientX - bounds.left - bounds.width / 2) / view.scale, z: view.z + (clientY - bounds.top - bounds.height / 2) / view.scale }; }
map.addEventListener("pointerdown", event => { if (event.button !== 0) return; drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; map.setPointerCapture(event.pointerId); map.classList.add("dragging"); });
map.addEventListener("pointermove", event => { if (!drag || event.pointerId !== drag.id) return; view.x -= (event.clientX - drag.x) / view.scale; view.z -= (event.clientY - drag.y) / view.scale; drag.x = event.clientX; drag.y = event.clientY; renderMap(); });
function stopDragging(event) { if (!drag || event.pointerId !== drag.id) return; drag = null; map.classList.remove("dragging"); }
map.addEventListener("pointerup", stopDragging);
map.addEventListener("pointercancel", stopDragging);
map.addEventListener("wheel", event => { event.preventDefault(); const world = worldAt(event.clientX, event.clientY); view.scale = Math.min(12, Math.max(.15, view.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15))); const bounds = map.getBoundingClientRect(); view.x = world.x - (event.clientX - bounds.left - bounds.width / 2) / view.scale; view.z = world.z - (event.clientY - bounds.top - bounds.height / 2) / view.scale; renderMap(); }, { passive: false });
document.getElementById("resetView").addEventListener("click", () => { view = { x: -111, z: 243, scale: 2 }; renderMap(); });
new ResizeObserver(renderMap).observe(map);
function connect() { clearTimeout(reconnectTimer); const protocol = location.protocol === "https:" ? "wss" : "ws"; socket = new WebSocket(`${protocol}://${location.host}/ws?role=radar-browser`); socket.onopen = () => { dot.classList.remove("offline"); connection.textContent = "Connected"; }; socket.onclose = () => { dot.classList.add("offline"); connection.textContent = "Disconnected"; reconnectTimer = setTimeout(connect, 2500); }; socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "radar") render(message.players || [], message.updatedAt); } catch {} }; }
connect();
