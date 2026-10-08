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
  readRegionFile,
  listRegionFiles
};
