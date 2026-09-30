-- =========================================================
-- RADAR MAP / RAW RADAR AGGREGATOR
-- =========================================================
-- Receives raw PLAYER tracks from every radar source using
-- the "radar_raw" Rednet protocol.
--
-- This program is a CONSUMER only:
--   * it hosts radar_raw so radar sources can find it
--   * it receives raw radar snapshots
--   * it keeps every sender separate
--   * it merges the latest observation for each UUID
--   * it never rebroadcasts received data
--
-- The combined result is written to radar_map_state.json so a
-- map renderer can consume it independently.
-- =========================================================

local REDNET_SIDE = "bottom"
local RAW_PROTOCOL = "radar_raw"
local RAW_HOSTNAME = "radar-map-" .. tostring(os.getComputerID())

local STATE_FILE = "radar_map_state.json"
local REMOTE_TIMEOUT = 10
local UPDATE_INTERVAL = 0.10
local DISPLAY_INTERVAL = 1

local usernameHelper = dofile("username_helper.lua")

local modem = peripheral.wrap(REDNET_SIDE)

if not modem then
    error("No modem found on side: " .. REDNET_SIDE)
end

if not modem.isWireless or not modem.isWireless() then
    error("Modem on " .. REDNET_SIDE .. " is not wireless")
end

if not rednet.isOpen(REDNET_SIDE) then
    rednet.open(REDNET_SIDE)
end

-- Hosting makes this computer a valid destination for radar_raw.
-- This program never sends on radar_raw, so received data cannot loop.
rednet.host(RAW_PROTOCOL, RAW_HOSTNAME)

local remoteRadarData = {}
local latestPlayers = {}
local lastStateTimestamp = nil
local lastDisplayAt = 0

local function sanitizeRawTrack(track)
    if type(track) ~= "table" or track.category ~= "PLAYER" then
        return nil
    end

    local uuid = type(track.id) == "string" and track.id or nil
    local position = track.position or {}
    local x = tonumber(position.x)
    local y = tonumber(position.y)
    local z = tonumber(position.z)

    if not uuid or uuid == "" or not x or not y or not z then
        return nil
    end

    return {
        id = uuid,
        category = "PLAYER",
        entityType =
            type(track.entityType) == "string"
            and track.entityType
            or nil,
        position = {
            x = x,
            y = y,
            z = z
        }
    }
end

local function acceptRadarPacket(sender, message)
    if type(message) ~= "table"
        or type(message.players) ~= "table" then
        return
    end

    local players = {}

    for _, track in ipairs(message.players) do
        local raw = sanitizeRawTrack(track)

        if raw then
            players[#players + 1] = raw
        end
    end

    remoteRadarData[sender] = {
        players = players,
        receivedAt = os.clock(),
        timestamp = tonumber(message.timestamp) or 0
    }
end

local function cleanupSources(now)
    for sender, source in pairs(remoteRadarData) do
        if now - source.receivedAt > REMOTE_TIMEOUT then
            remoteRadarData[sender] = nil
        end
    end
end

local function mergeRawPlayers()
    local merged = {}

    for _, source in pairs(remoteRadarData) do
        for _, track in ipairs(source.players) do
            local uuid = track.id
            local previous = merged[uuid]

            if not previous
                or source.timestamp >= previous.timestamp then
                merged[uuid] = {
                    id = uuid,
                    entityType = track.entityType,
                    x = track.position.x,
                    y = track.position.y,
                    z = track.position.z,
                    sourceTimestamp = source.timestamp
                }
            end
        end
    end

    return merged
end

local function buildPlayers()
    local merged = mergeRawPlayers()
    local players = {}

    for uuid, player in pairs(merged) do
        local username = usernameHelper.getCached(uuid)

        if not username then
            usernameHelper.queueUUID(uuid)
        end

        players[#players + 1] = {
            uuid = uuid,
            username = username,
            x = player.x,
            y = player.y,
            z = player.z,
            entityType = player.entityType,
            sourceTimestamp = player.sourceTimestamp
        }
    end

    table.sort(players, function(a, b)
        local nameA = a.username or a.uuid
        local nameB = b.username or b.uuid
        return nameA:lower() < nameB:lower()
    end)

    return players
end

local function writeState(players)
    local now = os.epoch("utc")

    local sourceCount = 0
    for _ in pairs(remoteRadarData) do
        sourceCount = sourceCount + 1
    end

    local state = {
        timestamp = now,
        sources = sourceCount,
        players = players
    }

    local file = fs.open(STATE_FILE, "w")

    if file then
        file.write(textutils.serialiseJSON(state))
        file.close()
    end

    latestPlayers = players
    lastStateTimestamp = now
end

local function rawReceiverLoop()
    while true do
        local sender, message, protocol = rednet.receive()

        if sender
            and sender ~= os.getComputerID()
            and protocol == RAW_PROTOCOL then
            acceptRadarPacket(sender, message)
        end
    end
end

local function usernameWorker()
    usernameHelper.worker(4)
end

local function updateLoop()
    while true do
        cleanupSources(os.clock())
        writeState(buildPlayers())
        sleep(UPDATE_INTERVAL)
    end
end

local function displayLoop()
    while true do
        local now = os.clock()

        if now - lastDisplayAt >= DISPLAY_INTERVAL then
            lastDisplayAt = now

            term.clear()
            term.setCursorPos(1, 1)
            term.setTextColor(colors.white)

            print("---- RADAR MAP ----")
            print("Protocol: " .. RAW_PROTOCOL)
            print("Hostname: " .. RAW_HOSTNAME)

            local sourceCount = 0
            for _ in pairs(remoteRadarData) do
                sourceCount = sourceCount + 1
            end

            print("Sources: " .. sourceCount)
            print("Players: " .. #latestPlayers)
            print("")

            for _, player in ipairs(latestPlayers) do
                local name = player.username
                    or ("UUID " .. player.uuid)

                print(string.format(
                    "%s %.1f %.1f %.1f",
                    name,
                    player.x,
                    player.y,
                    player.z
                ))
            end
        end

        sleep(0.1)
    end
end

print("RADAR MAP: receiver ready")
print("RADAR MAP: rednet side = " .. REDNET_SIDE)
print("RADAR MAP: protocol = " .. RAW_PROTOCOL)
print("RADAR MAP: hostname = " .. RAW_HOSTNAME)
print("RADAR MAP: waiting for radar sources...")

local ok, err = pcall(function()
    parallel.waitForAll(
        rawReceiverLoop,
        updateLoop,
        usernameWorker,
        displayLoop
    )
end)

if not ok then
    printError("RADAR MAP crashed:")
    printError(err)

    local file = fs.open("radar_map_error.log", "a")
    if file then
        file.writeLine(
            os.date("%Y-%m-%d %H:%M:%S")
                .. " "
                .. tostring(err)
        )
        file.close()
    end

    error(err)
end
