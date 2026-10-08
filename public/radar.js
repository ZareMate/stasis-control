const map = document.getElementById("radarMap");
const list = document.getElementById("playerList");
const sableList = document.getElementById("sableList");
const empty = document.getElementById("radarEmpty");
const dot = document.getElementById("dot");
const connection = document.getElementById("connectionText");
const meta = document.getElementById("radarMeta");
const coordinates = document.getElementById("radarCoordinates");
const showSable = document.getElementById("showSable");
const showFtbMap = document.getElementById("showFtbMap");
const ftbMapLayer = document.getElementById("ftbMapLayer");
const ftbChunksPanel = document.getElementById("ftbChunksPanel");
const ftbDimension = document.getElementById("ftbDimension");
const ftbMapFiles = document.getElementById("ftbMapFiles");
const ftbImportButton = document.getElementById("ftbImportButton");
const ftbFitButton = document.getElementById("ftbFitButton");
const ftbStatus = document.getElementById("ftbStatus");
const ftbRegionList = document.getElementById("ftbRegionList");
const ftbRegionCount = document.getElementById("ftbRegionCount");
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
const buildingCount = document.getElementById("buildingCount");
const roadCount = document.getElementById("roadCount");
let socket, reconnectTimer, players = [], sableContraptions = [], buildings = [], roads = [];
let radarCanModify = false;
let ftbRegions = [];
let ftbTileCache = new Map();
let ftbRenderToken = 0;
let ftbPalette = { blockByIndex: {}, colors: {}, types: {} };
let radarSignalReceived = false;
let view = { x: -111, z: 243, scale: 2 };
let drag = null;

let sableVisible = localStorage.getItem("radar-show-sable") !== "false";
let ftbMapVisible = localStorage.getItem("radar-show-ftb-map") !== "false";
showSable.checked = sableVisible;
if (showFtbMap) showFtbMap.checked = ftbMapVisible;
async function loadFtbPalette() {
  try {
    const response = await fetch("/ftbchunks-palette.json?build=2", { cache: "force-cache" });
    if (!response.ok) throw new Error("Unable to load FTB block palette");
    const palette = await response.json();
    if (palette && palette.blockByIndex) ftbPalette = palette;
  } catch (error) {
    console.warn("[Radar] FTB block palette unavailable:", error.message);
  }
}

async function loadRadarPermissions() {
  await loadFtbPalette();
  const response = await fetch("/api/auth", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.radarAllowed) {
    location.assign("/access-denied");
    return false;
  }

  radarCanModify = data.radarCanModify === true;

  const editors = document.querySelector(".map-editors");
  if (editors) {
    editors.hidden = !radarCanModify;
    editors.setAttribute("aria-hidden", String(!radarCanModify));
  }

  if (ftbChunksPanel) {
    ftbChunksPanel.hidden = !radarCanModify;
    ftbChunksPanel.setAttribute("aria-hidden", String(!radarCanModify));
  }

  if (radarCanModify) {
    await loadFtbRegions();
  } else {
    await loadFtbRegions();
  }

  return true;
}


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
for (const input of [buildingX1, buildingZ1, buildingX2, buildingZ2, roadX1, roadZ1, roadX2, roadZ2]) {
  input.addEventListener("blur", () => {
    const value = sanitizeCoordinate(input.value);
    if (Number.isFinite(value)) input.value = String(value);
  });
}
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

function ftbRegionUrl(region, layer) {
  return "/api/radar/ftbchunks/region/" +
    encodeURIComponent(region.name) + "/" + layer +
    "?dimension=" + encodeURIComponent(ftbDimension?.value?.trim() || "minecraft:overworld");
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load FTB Chunks image"));
    image.src = url;
  });
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16)
  ];
}

function fallbackFtbBlockColor(blockId) {
  const id = String(blockId || "").toLowerCase();
  const path = id.includes(":") ? id.split(":")[1] : id;

  const colors = {
    water: [63, 118, 228],
    flowing_water: [63, 118, 228],
    lava: [207, 96, 46],
    stone: [140, 140, 140],
    cobblestone: [122, 122, 122],
    deepslate: [78, 78, 78],
    tuff: [108, 112, 102],
    calcite: [224, 224, 219],
    diorite: [194, 194, 194],
    granite: [149, 103, 90],
    dirt: [128, 92, 60],
    coarse_dirt: [112, 78, 51],
    rooted_dirt: [125, 89, 64],
    clay: [159, 164, 177],
    gravel: [119, 112, 109],
    sand: [245, 231, 164],
    red_sand: [187, 95, 45],
    sandstone: [223, 215, 173],
    snow: [239, 239, 239],
    snow_block: [239, 239, 239],
    powder_snow: [232, 241, 249],
    ice: [145, 182, 247],
    packed_ice: [145, 182, 247],
    blue_ice: [145, 182, 247],
    grass_block: [100, 150, 75],
    podzol: [110, 87, 54],
    mycelium: [104, 82, 96],
    moss_block: [104, 130, 79],
    bedrock: [55, 55, 55],
    obsidian: [21, 0, 71],
    netherrack: [122, 53, 53],
    end_stone: [177, 173, 113],
    bricks: [174, 96, 75],
    nether_bricks: [46, 23, 27],
    quartz_block: [235, 229, 220],
    blackstone: [56, 50, 59],
    basalt: [80, 80, 84],
    polished_basalt: [90, 90, 94],
    prismarine: [82, 142, 135],
    sea_lantern: [170, 220, 210]
  };

  if (colors[path]) return colors[path];

  if (/\b(log|wood|planks|stem|hyphae)\b/.test(path)) {
    if (path.includes("dark_oak")) return [81, 45, 20];
    if (path.includes("spruce")) return [124, 94, 46];
    if (path.includes("birch")) return [242, 224, 147];
    if (path.includes("jungle")) return [198, 118, 83];
    if (path.includes("acacia")) return [224, 127, 62];
    if (path.includes("cherry")) return [190, 127, 117];
    return [150, 107, 62];
  }

  if (/leaves|leaf|vine/.test(path)) return [70, 100, 55];
  if (/sand/.test(path)) return [220, 190, 130];
  if (/stone|rock/.test(path)) return [128, 128, 128];
  if (/brick/.test(path)) return [155, 90, 75];
  if (/concrete|wool|terracotta/.test(path)) return [130, 130, 130];

  return [128, 128, 128];
}

function ftbTint(base, tint, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return [
    base[0] + (tint[0] - base[0]) * a,
    base[1] + (tint[1] - base[1]) * a,
    base[2] + (tint[2] - base[2]) * a
  ];
}

async function buildFtbTile(region) {
  const dimension = ftbDimension?.value?.trim() || "minecraft:overworld";
  const key = dimension + "|" + region.name;
  const cached = ftbTileCache.get(key);
  if (cached) return cached;

  const promise = Promise.all([
    imageFromUrl(ftbRegionUrl(region, "grass")),
    imageFromUrl(ftbRegionUrl(region, "foliage")),
    imageFromUrl(ftbRegionUrl(region, "water")),
    imageFromUrl(ftbRegionUrl(region, "data")),
    imageFromUrl(ftbRegionUrl(region, "blocks"))
  ]).then(([grass, foliage, water, data, blocks]) => {
    const width = 512;
    const height = 512;

    const readPixels = source => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };

    const grassPixels = readPixels(grass);
    const foliagePixels = readPixels(foliage);
    const waterPixels = readPixels(water);
    const dataPixels = readPixels(data);
    const blockPixels = readPixels(blocks);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.className = "radar-ftb-tile";
    canvas.setAttribute("aria-hidden", "true");

    const context = canvas.getContext("2d");
    const output = context.createImageData(width, height);

    for (let offset = 0; offset < output.data.length; offset += 4) {
      const packedWaterLightBiome = (dataPixels[offset + 2] << 8) | dataPixels[offset + 3];
      const hasWater = (packedWaterLightBiome & 0x8000) !== 0;
      const light = (packedWaterLightBiome >> 11) & 0x0f;

      const blockIndexHex =
        blockPixels[offset].toString(16).padStart(2, "0") +
        blockPixels[offset + 1].toString(16).padStart(2, "0") +
        blockPixels[offset + 2].toString(16).padStart(2, "0");

      const blockId = ftbPalette.blockByIndex[blockIndexHex.toUpperCase()];
      const customType = blockId ? ftbPalette.types[blockId] : null;
      let base;

      if (!blockId || customType === "ignored" || blockId === "minecraft:air" || blockId === "minecraft:void_air") {
        output.data[offset] = 0;
        output.data[offset + 1] = 0;
        output.data[offset + 2] = 0;
        output.data[offset + 3] = 0;
        continue;
      }

      // ColorMapLoader applies explicit ftbchunks_block_colors entries first.
      // Its built-in defaults then classify grass blocks as biome grass, leaves
      // and vines as biome foliage, rails as gray, and flower pots as brown.
      if (customType === "grass" || (/_grass_block$/.test(blockId) && !ftbPalette.colors[blockId])) {
        base = [
          grassPixels[offset],
          grassPixels[offset + 1],
          grassPixels[offset + 2]
        ];
        const darkness = 50 / 255;
        base = base.map(channel => channel * (1 - darkness));
      } else if (customType === "foliage" || (/(^|:)((.+_)?leaves|vine)$/.test(blockId) && !ftbPalette.colors[blockId])) {
        base = [
          foliagePixels[offset],
          foliagePixels[offset + 1],
          foliagePixels[offset + 2]
        ];
        const darkness = 50 / 255;
        base = base.map(channel => channel * (1 - darkness));
      } else if (blockId.endsWith("_rail") || /:(powered_rail|detector_rail|activator_rail)$/.test(blockId)) {
        base = [136, 136, 136];
      } else if (blockId.endsWith("flower_pot")) {
        base = [104, 58, 45];
      } else {
        base =
          parseHexColor(ftbPalette.colors[blockId]) ||
          fallbackFtbBlockColor(blockId);
      }

      if (hasWater) {
        const waterColor = [
          waterPixels[offset],
          waterPixels[offset + 1],
          waterPixels[offset + 2]
        ];
        base = ftbTint(base, waterColor, 220 / 255);
      }

      // In FTB's normal map mode, light level is not used to brighten terrain.
      // Instead it adds a small deterministic noise and height-based shadow.
      const pixelIndex = offset / 4;
      const px = pixelIndex % 512;
      const py = Math.floor(pixelIndex / 512);
      const west = py >= 0 && px > 0 ? offset - 4 : offset;
      const north = py > 0 ? offset - 512 * 4 : offset;

      const height = (dataPixels[offset] << 8) | dataPixels[offset + 1];
      const westHeight = (dataPixels[west] << 8) | dataPixels[west + 1];
      const northHeight = (dataPixels[north] << 8) | dataPixels[north + 1];

      let addedBrightness = 0;
      const shadow = 0.1 * (hasWater ? 0.6 : 1);
      if (height > northHeight || height > westHeight) addedBrightness += shadow;
      if (height < northHeight || height < westHeight) addedBrightness -= shadow;

      // Match FTB's default noise range of ±0.025.
      const hash = Math.sin((px + region.x * 512) * 12.9898 + (py + region.z * 512) * 78.233) * 43758.5453;
      const noise = (hash - Math.floor(hash)) * 0.05 - 0.025;
      addedBrightness += noise;

      output.data[offset] = clampChannel(base[0] + addedBrightness * 255);
      output.data[offset + 1] = clampChannel(base[1] + addedBrightness * 255);
      output.data[offset + 2] = clampChannel(base[2] + addedBrightness * 255);
      output.data[offset + 3] = 255;
    }

    context.putImageData(output, 0, 0);
    return canvas;
  });

  ftbTileCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    ftbTileCache.delete(key);
    console.error("[Radar] FTB Chunks tile failed:", region.name, error);
    throw error;
  }
}
function renderFtbMap(width, height) {
  if (!ftbMapLayer) return;

  const token = ++ftbRenderToken;
  ftbMapLayer.replaceChildren();

  if (!ftbMapVisible || !ftbRegions.length) return;

  const halfWorldWidth = width / (2 * view.scale);
  const halfWorldHeight = height / (2 * view.scale);
  const minWorldX = view.x - halfWorldWidth - 512;
  const maxWorldX = view.x + halfWorldWidth + 512;
  const minWorldZ = view.z - halfWorldHeight - 512;
  const maxWorldZ = view.z + halfWorldHeight + 512;

  const visible = ftbRegions.filter(region => {
    const x = region.x * 512;
    const z = region.z * 512;
    return x + 512 >= minWorldX && x <= maxWorldX &&
      z + 512 >= minWorldZ && z <= maxWorldZ;
  });

  for (const region of visible) {
    buildFtbTile(region).then(canvas => {
      if (token !== ftbRenderToken || !ftbMapVisible) return;

      const x = width / 2 + (region.x * 512 - view.x) * view.scale;
      const y = height / 2 + (region.z * 512 - view.z) * view.scale;

      canvas.style.left = x + "px";
      canvas.style.top = y + "px";
      canvas.style.width = 512 * view.scale + "px";
      canvas.style.height = 512 * view.scale + "px";
      ftbMapLayer.append(canvas);
    }).catch(() => {});
  }
}

function fitFtbMap() {
  if (!ftbRegions.length || !map) return;

  const { width, height } = map.getBoundingClientRect();
  if (!width || !height) return;

  const minX = Math.min(...ftbRegions.map(region => region.x * 512));
  const maxX = Math.max(...ftbRegions.map(region => region.x * 512 + 512));
  const minZ = Math.min(...ftbRegions.map(region => region.z * 512));
  const maxZ = Math.max(...ftbRegions.map(region => region.z * 512 + 512));

  view.x = (minX + maxX) / 2;
  view.z = (minZ + maxZ) / 2;

  const padding = 80;
  const spanX = Math.max(512, maxX - minX);
  const spanZ = Math.max(512, maxZ - minZ);
  view.scale = Math.min(
    4,
    Math.max(0.35, Math.min((width - padding) / spanX, (height - padding) / spanZ))
  );

  renderMap();
}

async function loadFtbRegions() {
  if (!ftbRegionList) return;

  const dimension = ftbDimension?.value?.trim() || "minecraft:overworld";
  try {
    const response = await fetch("/api/radar/ftbchunks?dimension=" + encodeURIComponent(dimension), { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load FTB Chunks regions");
    const data = await response.json();
    ftbRegions = Array.isArray(data.regions) ? data.regions : [];

    const prefix = dimension + "|";
    for (const key of [...ftbTileCache.keys()]) {
      if (!key.startsWith(prefix)) continue;
      if (!ftbRegions.some(region => key.endsWith("|" + region.name))) ftbTileCache.delete(key);
    }

    if (ftbRegionCount) ftbRegionCount.textContent = ftbRegions.length;
    ftbRegionList.innerHTML = ftbRegions.length
      ? ftbRegions.map(region =>
        '<div class="road-row ftb-region-row"><div><strong>' +
        escapeHtml(region.name) +
        '</strong><span>REGION X ' + region.x + ' · Z ' + region.z + ' · ' +
        region.chunkCount + ' chunks</span></div>' +
        (radarCanModify
          ? '<button class="road-delete ftb-region-delete" type="button" data-region="' +
            escapeHtml(region.name) + '">REMOVE</button>'
          : '') +
        '</div>'
      ).join("")
      : '<div class="empty-log">No FTB Chunks regions imported.</div>';

    renderMap();
    if (ftbRegions.length) fitFtbMap();
  } catch (error) {
    ftbRegions = [];
    if (ftbRegionCount) ftbRegionCount.textContent = "0";
    ftbRegionList.innerHTML = '<div class="empty-log">FTB Chunks map unavailable.</div>';
    ftbStatus.textContent = error.message;
    renderMap();
  }
}

async function importFtbRegions() {
  if (!radarCanModify || !ftbMapFiles || !ftbMapFiles.files.length) return;

  const dimension = ftbDimension?.value?.trim() || "minecraft:overworld";
  ftbImportButton.disabled = true;
  ftbStatus.textContent = "Importing…";

  try {
    for (const file of ftbMapFiles.files) {
      const match = file.name.match(/([0-9a-f]{5}-[0-9a-f]{5})/i);
      if (!match) throw new Error("Could not find an FTB region name in " + file.name);

      const region = match[1].toUpperCase();
      const response = await fetch(
        "/api/radar/ftbchunks/import?dimension=" +
        encodeURIComponent(dimension) + "&region=" + encodeURIComponent(region),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/zip",
            "X-FTBChunks-Region": region
          },
          body: file
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to import " + file.name);
    }

    ftbMapFiles.value = "";
    ftbTileCache = new Map();
    ftbStatus.textContent = "Regions imported.";
    await loadFtbRegions();
    fitFtbMap();
  } catch (error) {
    ftbStatus.textContent = error.message;
  } finally {
    ftbImportButton.disabled = false;
  }
}

function renderMap() {
  const { width, height } = map.getBoundingClientRect();
  if (!width || !height) return;
  map.querySelectorAll(".radar-player,.radar-sable,.radar-building,.radar-road").forEach(node => node.remove());
  const hasVisibleRadarData =
    players.length > 0 ||
    buildings.length > 0 ||
    roads.length > 0 ||
    (sableVisible && sableContraptions.length > 0);

  empty.hidden = hasVisibleRadarData;
  empty.textContent = radarSignalReceived
    ? "No radar contacts."
    : "Waiting for radar data…";
  empty.style.display = hasVisibleRadarData ? "none" : "grid";
  const grid = Math.max(12, 10 * view.scale);
  const offsetX = width / 2 - ((view.x * view.scale) % grid);
  const offsetZ = height / 2 - ((view.z * view.scale) % grid);
  map.style.backgroundSize = `${grid}px ${grid}px,${grid}px ${grid}px,${grid * 5}px ${grid * 5}px,${grid * 5}px ${grid * 5}px`;
  map.style.backgroundPosition = `${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px,${offsetX}px ${offsetZ}px`;
  renderFtbMap(width, height);
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
    const disabled = !radarCanModify || !sable.id ? " disabled" : "";
    return '<div class="radar-sable-row">' +
      '<div class="radar-sable-info">' +
      '<strong><i></i>SABLE ' + number + '</strong>' +
      '<span>X ' + Math.round(sable.x) + ' · Y ' + Math.round(sable.y) + ' · Z ' + Math.round(sable.z) +
      (sable.entityType ? ' · ' + escapeHtml(sable.entityType) : '') + '</span>' +
      '</div>' +
      radarCanModify
        ? '<div class="sable-name-edit">' +
          '<input class="sable-name-input" type="text" maxlength="40" autocomplete="off" placeholder="Custom name" value="' + safeName + '" data-sable-id="' + id + '"' + disabled + '>' +
          '<button class="sable-save" type="button" data-sable-id="' + id + '"' + disabled + '>SAVE</button>' +
          '</div>' +
          '<div class="sable-save-status" aria-live="polite"></div>'
        : '<div class="sable-save-status sable-read-only">View only</div>' +
      '</div>';
  }).join("") : '<div class="empty-log">No SABLE contraptions detected.</div>';
  if (buildingCount) buildingCount.textContent = buildings.length;
  if (roadCount) roadCount.textContent = roads.length;

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
if (showFtbMap) {
  showFtbMap.addEventListener("change", () => {
    ftbMapVisible = showFtbMap.checked;
    localStorage.setItem("radar-show-ftb-map", String(ftbMapVisible));
    renderMap();
  });
}

if (ftbImportButton) {
  ftbImportButton.addEventListener("click", importFtbRegions);
}
if (ftbFitButton) {
  ftbFitButton.addEventListener("click", fitFtbMap);
}
if (ftbDimension) {
  ftbDimension.addEventListener("change", () => {
    ftbTileCache = new Map();
    loadFtbRegions();
  });
}

if (ftbRegionList) {
  ftbRegionList.addEventListener("click", async event => {
    const button = event.target.closest(".ftb-region-delete");
    if (!button || !radarCanModify) return;

    button.disabled = true;
    const dimension = ftbDimension?.value?.trim() || "minecraft:overworld";
    try {
      const response = await fetch(
        "/api/radar/ftbchunks/region/" +
        encodeURIComponent(button.dataset.region) +
        "?dimension=" + encodeURIComponent(dimension),
        { method: "DELETE" }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Unable to remove FTB Chunks region");
      ftbTileCache = new Map();
      await loadFtbRegions();
      ftbStatus.textContent = "Region removed.";
    } catch (error) {
      ftbStatus.textContent = error.message;
      button.disabled = false;
    }
  });
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
  if (!radarCanModify) return;
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
function connect() { clearTimeout(reconnectTimer); const protocol = location.protocol === "https:" ? "wss" : "ws"; socket = new WebSocket(`${protocol}://${location.host}/ws?role=radar-browser`); socket.onopen = () => { dot.classList.remove("offline"); connection.textContent = "Connected"; }; socket.onclose = () => { dot.classList.add("offline"); connection.textContent = "Disconnected"; reconnectTimer = setTimeout(connect, 2500); }; socket.onmessage = event => { try { const message = JSON.parse(event.data); if (message.type === "radar") {
  radarSignalReceived = true;
  render(message.players || [], message.sableContraptions || [], message.buildings || [], message.roads || [], message.updatedAt);
} } catch {} }; }
loadRadarPermissions().then(allowed => { if (allowed) connect(); }).catch(() => location.assign("/access-denied"));
