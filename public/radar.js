const map = document.getElementById("radarMap");
const list = document.getElementById("playerList");
const sableList = document.getElementById("sableList");
const empty = document.getElementById("radarEmpty");
const dot = document.getElementById("dot");
const connection = document.getElementById("connectionText");
const meta = document.getElementById("radarMeta");
const coordinates = document.getElementById("radarCoordinates");
const showSable = document.getElementById("showSable");
const sablePanel = document.getElementById("sablePanel");
const sableLegend = document.getElementById("sableLegend");
const radarShell = map.closest(".radar-shell");
const buildingForm = document.getElementById("buildingForm");
const buildingId = document.getElementById("buildingId");
const buildingName = document.getElementById("buildingName");
const buildingX1 = document.getElementById("buildingX1");
const buildingZ1 = document.getElementById("buildingZ1");
const buildingX2 = document.getElementById("buildingX2");
const buildingZ2 = document.getElementById("buildingZ2");
const buildingList = document.getElementById("buildingList");
const buildingStatus = document.getElementById("buildingStatus");
const buildingSubmit = document.getElementById("buildingSubmit");
const roadForm = document.getElementById("roadForm");
const roadId = document.getElementById("roadId");
const roadX1 = document.getElementById("roadX1");
const roadZ1 = document.getElementById("roadZ1");
const roadX2 = document.getElementById("roadX2");
const roadZ2 = document.getElementById("roadZ2");
const roadList = document.getElementById("roadList");
const roadStatus = document.getElementById("roadStatus");
const roadSubmit = document.getElementById("roadSubmit");
let socket, reconnectTimer, players = [], sableContraptions = [], buildings = [], roads = [];
let view = { x: -111, z: 243, scale: 2 };
let drag = null;

let sableVisible = localStorage.getItem("radar-show-sable") !== "false";
showSable.checked = sableVisible;

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }
function statusFor(player) { const status = String(player.status || "unknown").toLowerCase(); return ["enemy", "ally", "team", "unknown"].includes(status) ? status : "unknown"; }
function sanitizeCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : NaN;
}
function sanitizeCoordinateInputs(inputs) {
  for (const input of inputs) {
    const value = sanitizeCoordinate(input.value);
    if (Number.isFinite(value)) input.value = String(value);
  }
}
function pasteBuildingCoordinates(event, xInput, zInput) {
  const text = (event.clipboardData?.getData("text") || "").trim();
  const teleport = text.match(/\btp\s+@\S+\s+(-?(?:\d+(?:\.\d+)?|\.\d+))\s+(-?(?:\d+(?:\.\d+)?|\.\d+))\s+(-?(?:\d+(?:\.\d+)?|\.\d+))/i);
  const values = teleport ? teleport.slice(1) : text.split(/[\s,]+/).filter(Boolean);
  if (values.length !== 1 && values.length !== 3) return;
  const numbers = values.map(sanitizeCoordinate);
  if (!numbers.every(Number.isFinite)) return;
  event.preventDefault();
  xInput.value = String(numbers[0]);
  if (numbers.length === 3) zInput.value = String(numbers[2]);
}
buildingX1.addEventListener("paste", event => pasteBuildingCoordinates(event, buildingX1, buildingZ1));
buildingX2.addEventListener("paste", event => pasteBuildingCoordinates(event, buildingX2, buildingZ2));
roadX1.addEventListener("paste", event => pasteBuildingCoordinates(event, roadX1, roadZ1));
roadX2.addEventListener("paste", event => pasteBuildingCoordinates(event, roadX2, roadZ2));
function renderRoadCenterlines(width, height) {
  map.querySelector(".radar-road-markings")?.remove();
  if (!roads.length) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("radar-road-markings");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const segments = roads.map(road => {
    const ax = width / 2 + (road.x1 - view.x) * view.scale;
    const ay = height / 2 + (road.z1 - view.z) * view.scale;
    const bx = width / 2 + (road.x2 - view.x) * view.scale;
    const by = height / 2 + (road.z2 - view.z) * view.scale;

    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const horizontal = (maxX - minX) >= (maxY - minY);

    return horizontal
      ? {
          road,
          horizontal: true,
          start: { x: minX, y: (minY + maxY) / 2 },
          end: { x: maxX, y: (minY + maxY) / 2 },
          minX, maxX, minY, maxY,
          halfWidth: Math.max(4, (maxY - minY) / 2)
        }
      : {
          road,
          horizontal: false,
          start: { x: (minX + maxX) / 2, y: minY },
          end: { x: (minX + maxX) / 2, y: maxY },
          minX, maxX, minY, maxY,
          halfWidth: Math.max(4, (maxX - minX) / 2)
        };
  });

  const EPS = Math.max(3, 2 * view.scale);
  const JUNCTION_GAP = Math.max(5, 3.5 * view.scale);

  const junctions = [];

  function within(value, min, max, tolerance = EPS) {
    return value >= min - tolerance && value <= max + tolerance;
  }

  function addJunction(a, b, start, end, kind) {
    junctions.push({ a, b, start, end, kind });
  }

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i];
      const b = segments[j];
      if (a.horizontal === b.horizontal) continue;

      const horizontal = a.horizontal ? a : b;
      const vertical = a.horizontal ? b : a;
      const centerCross = {
        x: vertical.start.x,
        y: horizontal.start.y
      };

      // Full crossroads: both centerlines pass through each other.
      if (
        within(centerCross.x, horizontal.start.x, horizontal.end.x) &&
        within(centerCross.y, vertical.start.y, vertical.end.y)
      ) {
        addJunction(horizontal, vertical, centerCross, centerCross, "cross");
        continue;
      }

      // Horizontal road joins the SIDE of a vertical road.
      const horizontalEndpoints = [horizontal.start, horizontal.end];
      for (const endpoint of horizontalEndpoints) {
        const sideX = Math.abs(endpoint.x - vertical.minX) <= EPS
          ? vertical.minX
          : Math.abs(endpoint.x - vertical.maxX) <= EPS
            ? vertical.maxX
            : null;

        if (
          sideX !== null &&
          within(endpoint.y, vertical.minY, vertical.maxY)
        ) {
          const target = {
            x: vertical.start.x,
            y: Math.max(vertical.minY, Math.min(vertical.maxY, endpoint.y))
          };
          addJunction(horizontal, vertical, endpoint, target, "join");
          break;
        }
      }

      // Vertical road joins the SIDE of a horizontal road.
      const verticalEndpoints = [vertical.start, vertical.end];
      for (const endpoint of verticalEndpoints) {
        const sideY = Math.abs(endpoint.y - horizontal.minY) <= EPS
          ? horizontal.minY
          : Math.abs(endpoint.y - horizontal.maxY) <= EPS
            ? horizontal.maxY
            : null;

        if (
          sideY !== null &&
          within(endpoint.x, horizontal.minX, horizontal.maxX)
        ) {
          const target = {
            x: Math.max(horizontal.minX, Math.min(horizontal.maxX, endpoint.x)),
            y: horizontal.start.y
          };
          addJunction(vertical, horizontal, endpoint, target, "join");
          break;
        }
      }
    }
  }

  const makePath = d => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "radar-road-centerline");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(path);
  };

  function pointKey(point) {
    return `${Math.round(point.x * 10) / 10}:${Math.round(point.y * 10) / 10}`;
  }

  // Draw the straight centerlines, breaking them at real crossroads and where
  // a side road turns into another road's centerline.
  for (const segment of segments) {
    const cuts = [{ value: segment.horizontal ? segment.start.x : segment.start.y, point: segment.start }];

    for (const junction of junctions) {
      if (junction.a !== segment && junction.b !== segment) continue;

      const point = junction.a === segment ? junction.start : junction.end;
      cuts.push({
        value: segment.horizontal ? point.x : point.y,
        point,
        junction
      });
    }

    cuts.push({ value: segment.horizontal ? segment.end.x : segment.end.y, point: segment.end });
    cuts.sort((a, b) => a.value - b.value);

    for (let index = 0; index < cuts.length - 1; index++) {
      const from = cuts[index];
      const to = cuts[index + 1];

      let fromGap = 0;
      let toGap = 0;

      if (from.junction) {
        fromGap = from.junction.kind === "cross"
          ? JUNCTION_GAP
          : JUNCTION_GAP * 0.65;
      }

      if (to.junction) {
        toGap = to.junction.kind === "cross"
          ? JUNCTION_GAP
          : JUNCTION_GAP * 0.65;
      }

      let fromValue = from.value + fromGap;
      let toValue = to.value - toGap;

      // When a junction point is not aligned with a segment endpoint, only open
      // the centerline locally. Endpoint joins stay visually connected by the curve.
      if (segment.horizontal) {
        fromValue = Math.max(fromValue, segment.start.x);
        toValue = Math.min(toValue, segment.end.x);
        if (toValue <= fromValue) continue;
        makePath(`M ${fromValue} ${segment.start.y} L ${toValue} ${segment.start.y}`);
      } else {
        fromValue = Math.max(fromValue, segment.start.y);
        toValue = Math.min(toValue, segment.end.y);
        if (toValue <= fromValue) continue;
        makePath(`M ${segment.start.x} ${fromValue} L ${segment.start.x} ${toValue}`);
      }
    }
  }

  // Draw smooth quarter-turn connectors for road edges that meet at a corner/T.
  // The connector starts at the actual road centerline endpoint and bends toward
  // the target road's centerline, rather than requiring their centerlines to cross.
  const drawn = new Set();

  for (const junction of junctions.filter(item => item.kind === "join")) {
    const aKey = pointKey(junction.start);
    const bKey = pointKey(junction.end);
    const key = [aKey, bKey].sort().join("|");
    if (drawn.has(key)) continue;
    drawn.add(key);

    const dx = junction.end.x - junction.start.x;
    const dy = junction.end.y - junction.start.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) continue;

    const radius = Math.min(
      Math.max(4, Math.min(junction.a.halfWidth, junction.b.halfWidth) * 0.8),
      Math.max(4, distance * 0.55)
    );

    const startSignX = Math.sign(junction.end.x - junction.start.x);
    const startSignY = Math.sign(junction.end.y - junction.start.y);

    let control;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const control1 = {
        x: junction.start.x + startSignX * radius,
        y: junction.start.y
      };
      const control2 = {
        x: junction.end.x,
        y: junction.end.y - Math.sign(dy) * radius
      };
      control =
        `M ${junction.start.x} ${junction.start.y} ` +
        `C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${junction.end.x} ${junction.end.y}`;
    } else {
      const control1 = {
        x: junction.start.x,
        y: junction.start.y + startSignY * radius
      };
      const control2 = {
        x: junction.end.x - Math.sign(dx) * radius,
        y: junction.end.y
      };
      control =
        `M ${junction.start.x} ${junction.start.y} ` +
        `C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${junction.end.x} ${junction.end.y}`;
    }

    makePath(control);
  }

  map.append(svg);
}

function renderMap() {
  const { width, height } = map.getBoundingClientRect();
  if (!width || !height) return;
  map.querySelectorAll(".radar-player,.radar-sable,.radar-building,.radar-road").forEach(node => node.remove());
  empty.hidden = players.length > 0 || buildings.length > 0 || roads.length > 0 || (sableVisible && sableContraptions.length > 0);
  const grid = Math.max(12, 10 * view.scale);
  const offsetX = width / 2 - ((view.x * view.scale) % grid);
  const offsetZ = height / 2 - ((view.z * view.scale) % grid);
  map.style.backgroundSize = `${grid}px ${grid}px,${grid}px ${grid}px,${grid * 5}px ${grid * 5}px,${grid * 5}px ${grid * 5}px`;
  map.style.backgroundPosition = `${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px`;
  coordinates.textContent = `X ${Math.round(view.x)} · Z ${Math.round(view.z)} · ${view.scale.toFixed(1)} px/block`;
  for (const road of roads) {
    const point = document.createElement("div");
    point.className = "radar-road";
    const minX = Math.min(road.x1, road.x2);
    const minZ = Math.min(road.z1, road.z2);
    point.style.left = (width / 2 + (minX - view.x) * view.scale) + "px";
    point.style.top = (height / 2 + (minZ - view.z) * view.scale) + "px";
    point.style.width = Math.max(14, Math.abs(road.x2 - road.x1) * view.scale) + "px";
    point.style.height = Math.max(14, Math.abs(road.z2 - road.z1) * view.scale) + "px";
    point.title = "Road: X " + road.x1 + "–" + road.x2 + ", Z " + road.z1 + "–" + road.z2;
    map.append(point);
  }

  renderRoadCenterlines(width, height);

  for (const player of players) {
    const point = document.createElement("div");
    const status = statusFor(player);
    point.className = "radar-player " + status;
    point.style.left = (width / 2 + (player.x - view.x) * view.scale) + "px";
    point.style.top = (height / 2 + (player.z - view.z) * view.scale) + "px";
    point.title = `${player.username}: X ${player.x}, Y ${player.y}, Z ${player.z} (${status})`;
    const head = document.createElement("img");
    head.src = `https://mc-heads.net/avatar/${encodeURIComponent(player.username)}/32`;
    head.alt = "";
    head.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = player.username;
    point.append(head, label);
    map.append(point);
  }

  for (const building of buildings) {
    const point = document.createElement("div");
    point.className = "radar-building";
    const minX = Math.min(building.x1, building.x2);
    const minZ = Math.min(building.z1, building.z2);
    point.style.left = (width / 2 + (minX - view.x) * view.scale) + "px";
    point.style.top = (height / 2 + (minZ - view.z) * view.scale) + "px";
    point.style.width = Math.max(14, Math.abs(building.x2 - building.x1) * view.scale) + "px";
    point.style.height = Math.max(14, Math.abs(building.z2 - building.z1) * view.scale) + "px";
    point.title = `${building.name}: X ${building.x1}–${building.x2}, Z ${building.z1}–${building.z2}`;
    const label = document.createElement("span");
    label.textContent = building.name;
    point.append(label);
    map.append(point);
  }

  if (!sableVisible) return;
  for (let index = 0; index < sableContraptions.length; index++) {
    const sable = sableContraptions[index];
    const number = sable.number || index + 1;
    const displayName = sable.name || "SABLE " + number;
    const point = document.createElement("div");
    point.className = "radar-sable";
    point.style.left = (width / 2 + (sable.x - view.x) * view.scale) + "px";
    point.style.top = (height / 2 + (sable.z - view.z) * view.scale) + "px";
    point.title = displayName +
      ": X " + sable.x + ", Y " + sable.y + ", Z " + sable.z;
    const label = document.createElement("span");
    label.textContent = displayName;
    point.append(label);
    map.append(point);
  }
}
function render(nextPlayers, nextSableContraptions, nextBuildings, nextRoads, updatedAt) {
  players = nextPlayers;
  sableContraptions = nextSableContraptions;
  buildings = nextBuildings;
  roads = nextRoads;
  renderMap();
  sablePanel.classList.toggle("sable-hidden", !sableVisible);
  sableLegend.classList.toggle("sable-hidden", !sableVisible);
  radarShell.classList.toggle("sable-filtered", !sableVisible);
  list.innerHTML = players.length ? players.map(player => {
    const status = statusFor(player);
    return `<div class="radar-row ${status}"><strong><i></i>${escapeHtml(player.username)}</strong><span>${status.toUpperCase()} · X ${Math.round(player.x)} · Y ${Math.round(player.y)} · Z ${Math.round(player.z)}${player.floor ? " · " + escapeHtml(player.floor) : ""}</span></div>`;
  }).join("") : '<div class="empty-log">No players detected.</div>';
  sableList.innerHTML = sableContraptions.length ? sableContraptions.map((sable, index) => {
    const number = sable.number || index + 1;
    const name = sable.name || "";
    const id = escapeHtml(sable.id || "");
    const safeName = escapeHtml(name).replace(/"/g, "&quot;");
    const disabled = sable.id ? "" : " disabled";
    return '<div class="radar-sable-row">' +
      '<div class="radar-sable-info">' +
      '<strong><i></i>SABLE ' + number + '</strong>' +
      '<span>X ' + Math.round(sable.x) + ' · Y ' + Math.round(sable.y) + ' · Z ' + Math.round(sable.z) +
      (sable.entityType ? ' · ' + escapeHtml(sable.entityType) : '') + '</span>' +
      '</div>' +
      '<div class="sable-name-edit">' +
      '<input class="sable-name-input" type="text" maxlength="40" autocomplete="off" placeholder="Custom name" value="' + safeName + '" data-sable-id="' + id + '"' + disabled + '>' +
      '<button class="sable-save" type="button" data-sable-id="' + id + '"' + disabled + '>SAVE</button>' +
      '</div>' +
      '<div class="sable-save-status" aria-live="polite"></div>' +
      '</div>';
  }).join("") : '<div class="empty-log">No SABLE contraptions detected.</div>';
  buildingList.innerHTML = buildings.length ? buildings.map(building =>
    '<div class="building-row"><div><strong>' + escapeHtml(building.name) + '</strong><span>X ' + Math.round(building.x1) + '–' + Math.round(building.x2) + ' · Z ' + Math.round(building.z1) + '–' + Math.round(building.z2) + '</span></div>' +
    '<div class="building-actions"><button class="building-edit" type="button" data-building-id="' + escapeHtml(building.id) + '">EDIT</button><button class="building-delete" type="button" data-building-id="' + escapeHtml(building.id) + '">REMOVE</button></div></div>'
  ).join("") : '<div class="empty-log">No buildings defined.</div>';

  roadList.innerHTML = roads.length ? roads.map((road, index) =>
    '<div class="road-row"><div><strong>ROAD ' + (index + 1) + '</strong><span>X ' + Math.round(road.x1) + '–' + Math.round(road.x2) + ' · Z ' + Math.round(road.z1) + '–' + Math.round(road.z2) + '</span></div>' +
    '<div class="road-actions"><button class="road-edit" type="button" data-road-id="' + escapeHtml(road.id) + '">EDIT</button><button class="road-delete" type="button" data-road-id="' + escapeHtml(road.id) + '">REMOVE</button></div></div>'
  ).join("") : '<div class="empty-log">No roads defined.</div>';
  meta.textContent = `${players.length} player${players.length === 1 ? "" : "s"}${sableVisible ? ` · ${sableContraptions.length} SABLE${sableContraptions.length === 1 ? "" : "s"}` : ""}${updatedAt ? " · updated " + new Date(updatedAt).toLocaleTimeString() : ""}`;
}
showSable.addEventListener("change", () => {
  sableVisible = showSable.checked;
  localStorage.setItem("radar-show-sable", String(sableVisible));
  render(players, sableContraptions, buildings, roads);
});
buildingForm.addEventListener("submit", async event => {
  event.preventDefault();
  sanitizeCoordinateInputs([buildingX1, buildingZ1, buildingX2, buildingZ2]);
  const editing = Boolean(buildingId.value);
  buildingSubmit.disabled = true;
  buildingStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/radar/building", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: buildingId.value, name: buildingName.value, x1: buildingX1.value, z1: buildingZ1.value, x2: buildingX2.value, z2: buildingZ2.value })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Unable to save building");
    buildings = [...buildings.filter(building => building.id !== result.building.id), result.building];
    render(players, sableContraptions, buildings, roads, Date.now());
    buildingForm.reset();
    buildingSubmit.textContent = "ADD BUILDING";
    buildingStatus.textContent = editing ? "Building updated." : "Building added.";
  } catch (error) {
    buildingStatus.textContent = error.message;
  } finally {
    buildingSubmit.disabled = false;
  }
});
roadForm.addEventListener("submit", async event => {
  event.preventDefault();
  sanitizeCoordinateInputs([roadX1, roadZ1, roadX2, roadZ2]);
  const editing = Boolean(roadId.value);
  roadSubmit.disabled = true;
  roadStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/radar/road", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: roadId.value,
        x1: roadX1.value,
        z1: roadZ1.value,
        x2: roadX2.value,
        z2: roadZ2.value
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Unable to save road");
    roads = [...roads.filter(road => road.id !== result.road.id), result.road];
    render(players, sableContraptions, buildings, roads, Date.now());
    roadForm.reset();
    roadSubmit.textContent = "ADD ROAD";
    roadStatus.textContent = editing ? "Road updated." : "Road added.";
  } catch (error) {
    roadStatus.textContent = error.message;
  } finally {
    roadSubmit.disabled = false;
  }
});

roadList.addEventListener("click", async event => {
  const editButton = event.target.closest(".road-edit");
  if (editButton) {
    const road = roads.find(item => item.id === editButton.dataset.roadId);
    if (!road) return;
    roadId.value = road.id;
    roadX1.value = sanitizeCoordinate(road.x1);
    roadZ1.value = sanitizeCoordinate(road.z1);
    roadX2.value = sanitizeCoordinate(road.x2);
    roadZ2.value = sanitizeCoordinate(road.z2);
    roadSubmit.textContent = "SAVE CHANGES";
    roadStatus.textContent = "Editing Road " + (roads.indexOf(road) + 1) + ".";
    roadX1.focus();
    return;
  }

  const button = event.target.closest(".road-delete");
  if (!button) return;
  button.disabled = true;
  roadStatus.textContent = "Removing…";
  try {
    const response = await fetch("/api/radar/road/" + encodeURIComponent(button.dataset.roadId), { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Unable to remove road");
    roads = roads.filter(road => road.id !== button.dataset.roadId);
    render(players, sableContraptions, buildings, roads, Date.now());
    if (roadId.value === button.dataset.roadId) {
      roadForm.reset();
      roadSubmit.textContent = "ADD ROAD";
    }
    roadStatus.textContent = "Road removed.";
  } catch (error) {
    roadStatus.textContent = error.message;
    button.disabled = false;
  }
});

buildingList.addEventListener("click", async event => {
  const editButton = event.target.closest(".building-edit");
  if (editButton) {
    const building = buildings.find(item => item.id === editButton.dataset.buildingId);
    if (!building) return;
    buildingId.value = building.id;
    buildingName.value = building.name;
    buildingX1.value = sanitizeCoordinate(building.x1);
    buildingZ1.value = sanitizeCoordinate(building.z1);
    buildingX2.value = sanitizeCoordinate(building.x2);
    buildingZ2.value = sanitizeCoordinate(building.z2);
    buildingSubmit.textContent = "SAVE CHANGES";
    buildingStatus.textContent = "Editing " + building.name + ".";
    buildingName.focus();
    return;
  }

  const button = event.target.closest(".building-delete");
  if (!button) return;
  button.disabled = true;
  buildingStatus.textContent = "Removing…";
  try {
    const response = await fetch("/api/radar/building/" + encodeURIComponent(button.dataset.buildingId), { method: "DELETE" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Unable to remove building");
    buildings = buildings.filter(building => building.id !== button.dataset.buildingId);
    render(players, sableContraptions, buildings, roads, Date.now());
    if (buildingId.value === button.dataset.buildingId) {
      buildingForm.reset();
      buildingSubmit.textContent = "ADD BUILDING";
    }
    buildingStatus.textContent = "Building removed.";
  } catch (error) {
    buildingStatus.textContent = error.message;
    button.disabled = false;
  }
});
sableList.addEventListener("click", async event => {
  const button = event.target.closest(".sable-save");
  if (!button || button.disabled) return;

  const id = button.dataset.sableId || "";
  const row = button.closest(".radar-sable-row");
  const input = row?.querySelector(".sable-name-input");
  const status = row?.querySelector(".sable-save-status");
  if (!id || !input) return;

  button.disabled = true;
  if (status) status.textContent = "Saving…";

  try {
    const response = await fetch("/api/radar/sable-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: input.value })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Save failed");

    const sable = sableContraptions.find(item => item.id === id);
    if (sable) sable.name = result.name || null;
    render(players, sableContraptions, buildings, roads, Date.now());
  } catch (error) {
    if (status) status.textContent = error.message;
    button.disabled = false;
  }
});

sableList.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  const input = event.target.closest(".sable-name-input");
  if (!input) return;
  event.preventDefault();
  input.closest(".radar-sable-row")?.querySelector(".sable-save")?.click();
});

function worldAt(clientX, clientY) { const bounds = map.getBoundingClientRect(); return { x: view.x + (clientX - bounds.left - bounds.width / 2) / view.scale, z: view.z + (clientY - bounds.top - bounds.height / 2) / view.scale }; }
map.addEventListener("pointerdown", event => { if (event.button !== 0 || event.target.closest(".radar-controls")) return; drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; map.setPointerCapture(event.pointerId); map.classList.add("dragging"); });
map.addEventListener("pointermove", event => { if (!drag || event.pointerId !== drag.id) return; view.x -= (event.clientX - drag.x) / view.scale; view.z -= (event.clientY - drag.y) / view.scale; drag.x = event.clientX; drag.y = event.clientY; renderMap(); });
function stopDragging(event) { if (!drag || event.pointerId !== drag.id) return; drag = null; map.classList.remove("dragging"); }
map.addEventListener("pointerup", stopDragging);
map.addEventListener("pointercancel", stopDragging);
map.addEventListener("wheel", event => { event.preventDefault(); const world = worldAt(event.clientX, event.clientY); view.scale = Math.min(12, Math.max(.15, view.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15))); const bounds = map.getBoundingClientRect(); view.x = world.x - (event.clientX - bounds.left - bounds.width / 2) / view.scale; view.z = world.z - (event.clientY - bounds.top - bounds.height / 2) / view.scale; renderMap(); }, { passive: false });
document.getElementById("resetView").addEventListener("click", () => { view = { x: -111, z: 243, scale: 2 }; renderMap(); });
new ResizeObserver(renderMap).observe(map);
function connect() { clearTimeout(reconnectTimer); const protocol = location.protocol === "https:" ? "wss" : "ws"; socket = new WebSocket(`${protocol}://${location.host}/ws?role=radar-browser`); socket.onopen = () => { dot.classList.remove("offline"); connection.textContent = "Connected"; }; socket.onclose = () => { dot.classList.add("offline"); connection.textContent = "Disconnected"; reconnectTimer = setTimeout(connect, 2500); }; socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "radar") render(message.players || [], message.sableContraptions || [], message.buildings || [], message.roads || [], message.updatedAt); } catch {} }; }
connect();
