const map = document.getElementById("radarMap");
const list = document.getElementById("playerList");
const empty = document.getElementById("radarEmpty");
const dot = document.getElementById("dot");
const connection = document.getElementById("connectionText");
const meta = document.getElementById("radarMeta");
let socket, reconnectTimer;
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function render(players, updatedAt) {
  const xs = players.map(p => p.x), zs = players.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const paddingX = Math.max(25, (maxX - minX) * .12), paddingZ = Math.max(25, (maxZ - minZ) * .12);
  const left = minX - paddingX, width = Math.max(1, maxX - minX + paddingX * 2), top = minZ - paddingZ, height = Math.max(1, maxZ - minZ + paddingZ * 2);
  map.querySelectorAll(".radar-player").forEach(node => node.remove());
  empty.hidden = players.length > 0;
  for (const player of players) { const point = document.createElement("div"); const status = String(player.status || "unknown").toLowerCase(); point.className = "radar-player " + status; point.style.left = ((player.x - left) / width * 100) + "%"; point.style.top = ((player.z - top) / height * 100) + "%"; point.title = `${player.username}: X ${player.x}, Y ${player.y}, Z ${player.z}`; point.innerHTML = `<span>${escapeHtml(player.username)}</span>`; map.append(point); }
  list.innerHTML = players.length ? players.map(p => `<div class="radar-row ${escapeHtml(String(p.status || "unknown").toLowerCase())}"><strong>${escapeHtml(p.username)}</strong><span>X ${Math.round(p.x)} · Y ${Math.round(p.y)} · Z ${Math.round(p.z)}${p.floor ? " · " + escapeHtml(p.floor) : ""}</span></div>`).join("") : '<div class="empty-log">No players detected.</div>';
  meta.textContent = `${players.length} player${players.length === 1 ? "" : "s"}${updatedAt ? " · updated " + new Date(updatedAt).toLocaleTimeString() : ""}`;
}
function connect() { clearTimeout(reconnectTimer); const protocol = location.protocol === "https:" ? "wss" : "ws"; socket = new WebSocket(`${protocol}://${location.host}/ws?role=radar-browser`); socket.onopen = () => { dot.classList.remove("offline"); connection.textContent = "Connected"; }; socket.onclose = () => { dot.classList.add("offline"); connection.textContent = "Disconnected"; reconnectTimer = setTimeout(connect, 2500); }; socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "radar") render(message.players || [], message.updatedAt); } catch {} }; }
connect();
