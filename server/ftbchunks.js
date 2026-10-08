const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const REGION_SIZE = 512;
const REGION_BLOCKS = 32;
const MAX_ZIP_ENTRY_SIZE = 64 * 1024 * 1024;
const SUPPORTED_LAYERS = new Set([
  "data.png",
  "grass.png",
  "foliage.png",
  "water.png",
  "blocks.png"
]);

function parseRegionName(name) {
  const value = path.basename(String(name || "")).replace(/\.zip$/i, "");
  const match = value.match(/^([0-9a-f]{5})-([0-9a-f]{5})(?:\(\d+\))?$/i);
  if (!match) return null;

  // FTB Library's XZ#toRegionString stores region coordinates as
  // String.format("%05X-%05X", x + 60000, z + 60000).
  return {
    name: value.toUpperCase().replace(/\(\d+\)$/i, ""),
    x: parseInt(match[1], 16) - 60000,
    z: parseInt(match[2], 16) - 60000
  };
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0xFFFF - 22);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function zipEntries(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Expected a ZIP buffer");

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("Invalid ZIP: end-of-central-directory record not found");

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (disk !== 0 || centralDisk !== 0 || entryCount === 0xFFFF) {
    throw new Error("Unsupported ZIP: multi-disk or ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error("Invalid ZIP: central directory is outside the archive");
  }

  const entries = new Map();
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP: malformed central directory entry");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    if (flags & 0x0001) throw new Error(`Unsupported ZIP encryption for ${name}`);
    if (compressedSize > MAX_ZIP_ENTRY_SIZE || uncompressedSize > MAX_ZIP_ENTRY_SIZE) {
      throw new Error(`ZIP entry ${name} is too large`);
    }

    entries.set(name, {
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipEntry(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;

  const { localOffset } = entry;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP local header for ${name}`);
  }

  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;

  if (start < 0 || end > buffer.length) {
    throw new Error(`Invalid ZIP data bounds for ${name}`);
  }

  const compressed = buffer.subarray(start, end);
  let result;

  if (entry.method === 0) {
    result = Buffer.from(compressed);
  } else if (entry.method === 8) {
    result = zlib.inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
  }

  if (result.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry ${name} failed size validation`);
  }

  return result;
}

function parseChunksDat(buffer) {
  if (!buffer || buffer.length < 4) throw new Error("chunks.dat is too small");

  const version = buffer.readUInt8(1);
  const count = buffer.readUInt16BE(2);
  let offset = 4;
  const chunks = [];

  for (let index = 0; index < count; index++) {
    if (offset + (version >= 2 ? 11 : 10) > buffer.length) {
      throw new Error("Invalid chunks.dat: truncated chunk record");
    }

    const chunkVersion = version >= 2 ? buffer.readUInt8(offset++) : 0;
    const x = buffer.readInt8(offset++);
    const z = buffer.readInt8(offset++);
    const lastModified = Number(buffer.readBigInt64BE(offset));
    offset += 8;

    chunks.push({ x, z, version: chunkVersion, lastModified });
  }

  return { version, chunks };
}

function readPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Invalid PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;

    if (dataEnd > buffer.length || crcEnd > buffer.length) {
      throw new Error("Invalid PNG chunk bounds");
    }

    if (type === "IHDR") {
      if (length !== 13) throw new Error("Invalid PNG IHDR");
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];

      if (
        bitDepth !== 8 ||
        ![0, 2, 4, 6].includes(colorType) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("Unsupported PNG format");
      }
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    offset = crcEnd;
  }

  if (!width || !height || !idat.length) {
    throw new Error("PNG is missing required image data");
  }

  const channels = {
    0: 1,
    2: 3,
    4: 2,
    6: 4
  }[colorType];

  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowSize = stride + 1;

  if (raw.length !== rowSize * height) {
    throw new Error("PNG decompressed size does not match image dimensions");
  }

  const rgba = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const row = Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const value = raw[rawOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] || 0;
      const upLeft = x >= channels ? previous[x - channels] || 0 : 0;

      switch (filterType) {
        case 0:
          row[x] = value;
          break;
        case 1:
          row[x] = (value + left) & 0xff;
          break;
        case 2:
          row[x] = (value + up) & 0xff;
          break;
        case 3:
          row[x] = (value + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          row[x] = (value + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error("Unsupported PNG filter type");
      }
    }

    const outRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = outRow + x * 4;

      if (colorType === 0) {
        const gray = row[src];
        rgba[dst] = gray;
        rgba[dst + 1] = gray;
        rgba[dst + 2] = gray;
        rgba[dst + 3] = 255;
      } else if (colorType === 2) {
        rgba[dst] = row[src];
        rgba[dst + 1] = row[src + 1];
        rgba[dst + 2] = row[src + 2];
        rgba[dst + 3] = 255;
      } else if (colorType === 4) {
        const gray = row[src];
        rgba[dst] = gray;
        rgba[dst + 1] = gray;
        rgba[dst + 2] = gray;
        rgba[dst + 3] = row[src + 1];
      } else {
        rgba[dst] = row[src];
        rgba[dst + 1] = row[src + 1];
        rgba[dst + 2] = row[src + 2];
        rgba[dst + 3] = row[src + 3];
      }
    }

    row.copy(previous);
  }

  return { width, height, rgba };
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuffer, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function writePng(image) {
  const { width, height, rgba } = image;
  if (width <= 0 || height <= 0 || width > REGION_SIZE || height > REGION_SIZE) {
    throw new Error("Invalid PNG dimensions");
  }

  const rowSize = width * 4;
  const raw = Buffer.alloc((rowSize + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0;
    rgba.copy(
      raw,
      y * (rowSize + 1) + 1,
      y * rowSize,
      (y + 1) * rowSize
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function writeChunksDat(version, chunks) {
  const recordSize = version >= 2 ? 11 : 10;
  const result = Buffer.alloc(4 + chunks.length * recordSize);
  result[1] = version;
  result.writeUInt16BE(chunks.length, 2);

  let offset = 4;
  for (const chunk of chunks) {
    if (version >= 2) result[offset++] = chunk.version & 0xff;
    result[offset++] = chunk.x & 0xff;
    result[offset++] = chunk.z & 0xff;
    result.writeBigInt64BE(BigInt(Math.trunc(chunk.lastModified)), offset);
    offset += 8;
  }

  return result;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(Buffer.concat([local, nameBuffer, compressed]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([central, nameBuffer]));
    offset += localParts.at(-1).length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const locals = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(locals.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([locals, centralDirectory, eocd]);
}

function mergeRegionBuffers(existingBuffer, incomingBuffer, expectedRegion) {
  const oldInfo = inspectRegionBuffer(existingBuffer, expectedRegion);
  const newInfo = inspectRegionBuffer(incomingBuffer, expectedRegion);
  const oldEntries = zipEntries(existingBuffer);
  const newEntries = zipEntries(incomingBuffer);

  const chunkMap = new Map();
  for (const chunk of oldInfo.chunks) {
    chunkMap.set(chunk.x + "," + chunk.z, { ...chunk });
  }

  let selectedIncoming = 0;
  let selectedExisting = 0;

  for (const incoming of newInfo.chunks) {
    const key = incoming.x + "," + incoming.z;
    const existing = chunkMap.get(key);
    if (!existing || incoming.lastModified >= existing.lastModified) {
      chunkMap.set(key, { ...incoming });
      if (existing) selectedIncoming++;
    } else {
      selectedExisting++;
    }
  }

  const mergedChunks = [...chunkMap.values()].sort((a, b) =>
    a.z - b.z || a.x - b.x
  );
  const outputEntries = new Map();

  // Preserve additional files from either archive, preferring the new upload.
  for (const [name] of oldEntries) {
    const data = readZipEntry(existingBuffer, oldEntries, name);
    if (data) outputEntries.set(name, data);
  }
  for (const [name] of newEntries) {
    const data = readZipEntry(incomingBuffer, newEntries, name);
    if (data) outputEntries.set(name, data);
  }

  for (const layer of SUPPORTED_LAYERS) {
    const oldPngBuffer = readZipEntry(existingBuffer, oldEntries, layer);
    const newPngBuffer = readZipEntry(incomingBuffer, newEntries, layer);
    const oldPng = readPng(oldPngBuffer);
    const newPng = readPng(newPngBuffer);

    if (
      oldPng.width !== REGION_SIZE || oldPng.height !== REGION_SIZE ||
      newPng.width !== REGION_SIZE || newPng.height !== REGION_SIZE
    ) {
      throw new Error("FTB Chunks map layers must be 512x512 PNGs");
    }

    const mergedPng = {
      width: REGION_SIZE,
      height: REGION_SIZE,
      rgba: Buffer.from(oldPng.rgba)
    };

    for (const incoming of newInfo.chunks) {
      const key = incoming.x + "," + incoming.z;
      const selected = chunkMap.get(key);
      if (!selected || selected.lastModified !== incoming.lastModified) continue;

      const previous = oldInfo.chunks.find(chunk =>
        chunk.x === incoming.x &&
        chunk.z === incoming.z
      );

      if (previous && previous.lastModified > incoming.lastModified) continue;

      const startX = incoming.x * 16;
      const startY = incoming.z * 16;

      for (let y = 0; y < 16; y++) {
        const sourceStart = ((startY + y) * REGION_SIZE + startX) * 4;
        const sourceEnd = sourceStart + 16 * 4;
        const targetStart = sourceStart;
        newPng.rgba.copy(mergedPng.rgba, targetStart, sourceStart, sourceEnd);
      }
    }

    outputEntries.set(layer, writePng(mergedPng));
  }

  outputEntries.set(
    "chunks.dat",
    writeChunksDat(Math.max(oldInfo.version, newInfo.version), mergedChunks)
  );

  return {
    buffer: writeZip([...outputEntries.entries()]),
    chunks: mergedChunks,
    added: Math.max(0, newInfo.chunks.length - oldInfo.chunks.length),
    updated: selectedIncoming,
    skippedOlder: selectedExisting,
    incomingChunks: newInfo.chunks.length,
    finalChunks: mergedChunks.length
  };
}

function inspectRegionBuffer(buffer, expectedRegion) {
  const info = parseRegionName(expectedRegion);
  if (!info) throw new Error("Invalid FTB Chunks region name; expected XXXXX-XXXXX.zip");

  const entries = zipEntries(buffer);
  for (const name of ["chunks.dat", ...SUPPORTED_LAYERS]) {
    if (!entries.has(name)) throw new Error(`FTB Chunks region is missing ${name}`);
  }

  const chunks = parseChunksDat(readZipEntry(buffer, entries, "chunks.dat"));
  return {
    ...info,
    version: chunks.version,
    chunks: chunks.chunks
  };
}

function readRegionFile(file) {
  const parsed = parseRegionName(file);
  if (!parsed) throw new Error(`Invalid FTB Chunks region filename: ${file}`);

  const buffer = fs.readFileSync(file);
  const info = inspectRegionBuffer(buffer, parsed.name);
  return {
    ...info,
    file,
    size: buffer.length
  };
}

function listRegionFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(item => item.isFile() && parseRegionName(item.name))
    .map(item => readRegionFile(path.join(directory, item.name)));
}

module.exports = {
  REGION_SIZE,
  REGION_BLOCKS,
  SUPPORTED_LAYERS,
  parseRegionName,
  zipEntries,
  readZipEntry,
  parseChunksDat,
  inspectRegionBuffer,
  mergeRegionBuffers,
  readPng,
  writePng,
  writeChunksDat,
  readRegionFile,
  listRegionFiles
};
