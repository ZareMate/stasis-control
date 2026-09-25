-- =========================================================
-- RADAR SCANNER / DATA PROCESS
-- =========================================================
-- This process does ONLY:
--   * read radar monitors
--   * UUID -> username resolution
--   * remote radar/rednet input
--   * local radar/rednet output
--   * WebSocket dashboard output
--   * publish a shared snapshot for GUI + redstone
--
-- GUI drawing and redstone are deliberately NOT done here.

local CATEGORY_FILTER = "PLAYER"
local DATABASE_FILE = "users.json"
local STATE_FILE = "radar_state.json"
local PROTOCOL = "radar"

local REDNET_SIDE = "bottom"
local DESTINATION_IDS = { 70 }

local RADAR_WS_URL =
"wss://stasis.suchodupin.com/ws?role=radar&token=YOUR-STASIS_TOKEN"

local RADAR_INTERVAL = 0.10
local DB_RELOAD_INTERVAL = 1.0
local REMOTE_TIMEOUT = 10

-- Debug timing
local DEBUG_TIMING = true
local maxLoopTimeMs = 0
local avgLoopTimeMs = 0
local loopSamples = 0

local SQUARE_CENTER_X = -111
local SQUARE_CENTER_Z = 243
local SQUARE_HALF_SIZE = 100
local SQUARE_X1 = SQUARE_CENTER_X - SQUARE_HALF_SIZE
local SQUARE_X2 = SQUARE_CENTER_X + SQUARE_HALF_SIZE
local SQUARE_Z1 = SQUARE_CENTER_Z - SQUARE_HALF_SIZE
local SQUARE_Z2 = SQUARE_CENTER_Z + SQUARE_HALF_SIZE

local FLOOR_HALF_SIZE = 50
local FLOOR_X1 = SQUARE_CENTER_X - FLOOR_HALF_SIZE
local FLOOR_X2 = SQUARE_CENTER_X + FLOOR_HALF_SIZE
local FLOOR_Z1 = SQUARE_CENTER_Z - FLOOR_HALF_SIZE
local FLOOR_Z2 = SQUARE_CENTER_Z + FLOOR_HALF_SIZE

local REDSTONE_DETECTION_AREA = { -99, 70, 250, -96, 72, 247 }
local ALLY_RELAY_AREAS = {
    REDSTONE_DETECTION_AREA,
    { -103, 78, 253, -97, 71, 250 }
}
local MAIN_DOOR_OPEN_AREA = { -98, 70, 245, -97, 72, 248 }
local PORTAL_DOOR_OPEN_AREA = { -96, 69, 239, -94, 71, 238 }

local radarMonitors = { peripheral.find("create_radar:monitor") }
local modem = peripheral.wrap(REDNET_SIDE)
local rednetEnabled = modem
    and modem.isWireless
    and modem.isWireless()

local USERNAME_LIST = {}
local nameCache = {}
local remotePlayers = {}
local latestRadarData = {}
local latestSableData = {}
local latestState = {}
local radarWebSocket = nil
local nextRadarReconnect = 0
local lastDatabaseLoad = 0

local function loadDatabase()
    if not fs.exists(DATABASE_FILE) then
        return {}
    end

    local file = fs.open(DATABASE_FILE, "r")
    if not file then return {} end

    local data = textutils.unserialiseJSON(file.readAll())
    file.close()

    if type(data) == "table" then
        return data
    end
    return {}
end

local function reloadDatabase(force)
    local now = os.clock()
    if force or now - lastDatabaseLoad >= DB_RELOAD_INTERVAL then
        local data = loadDatabase()
        if type(data) == "table" then
            USERNAME_LIST = data
        end
        lastDatabaseLoad = now
    end
end

local function isInsideArea(area, x, y, z)
    local minX = math.min(area[1], area[4])
    local maxX = math.max(area[1], area[4])
    local minY = math.min(area[2], area[5])
    local maxY = math.max(area[2], area[5])
    local minZ = math.min(area[3], area[6])
    local maxZ = math.max(area[3], area[6])
    return x >= minX and x <= maxX
        and y >= minY and y <= maxY
        and z >= minZ and z <= maxZ
end

local function isInsidePlayerSquare(x, z)
    return x >= SQUARE_X1 and x <= SQUARE_X2
        and z >= SQUARE_Z1 and z <= SQUARE_Z2
end

local function isWithinFloorSquare(x, z)
    return x >= FLOOR_X1 and x <= FLOOR_X2
        and z >= FLOOR_Z1 and z <= FLOOR_Z2
end

local function isInsideAnyAllyRelayArea(x, y, z)
    for _, area in ipairs(ALLY_RELAY_AREAS) do
        if isInsideArea(area, x, y, z) then
            return true
        end
    end
    return false
end

local function getPlayerFloor(y)
    if y >= 68 and y <= 71 then
        return "TOP"
    elseif y >= 56 and y <= 64 then
        return "PWR"
    elseif y >= 38 and y <= 46 then
        return "NWF"
    elseif y >= 29 and y <= 33 then
        return "SRV"
    elseif y >= 22 and y <= 27 then
        return "MAIN"
    elseif y >= 12 and y <= 18 then
        return "MCH"
    elseif y >= -11 and y <= -7 then
        return "LAVA"
    elseif y < -20 then
        return "MINE"
    end
    return nil
end

local function resolveUsernameFromUUID(uuid)
    if not uuid or uuid == "" or not http then return nil end
    if nameCache[uuid] ~= nil then
        return nameCache[uuid] or nil
    end

    local ok, result = pcall(function()
        local res = http.get(
            "https://playerdb.co/api/player/minecraft/" .. uuid
        )
        if not res then return nil end

        local body = res.readAll()
        res.close()

        local data = textutils.unserialiseJSON(body)
        if type(data) ~= "table" then return nil end

        return data.data
            and data.data.player
            and data.data.player.username
    end)

    if ok and type(result) == "string" and result ~= "" then
        nameCache[uuid] = result
        return result
    end

    nameCache[uuid] = false
    return nil
end

local function acceptRadarMessage(sender, message)
    if type(message) ~= "table" or type(message.data) ~= "table" then
        return
    end

    local snapshot = {}
    for _, row in ipairs(message.data) do
        if type(row) == "table"
            and type(row.username) == "string"
            and #row.username > 0
            and #row.username <= 32 then
            local x = tonumber(row.x)
            local y = tonumber(row.y)
            local z = tonumber(row.z)

            if x and y and z then
                snapshot[#snapshot + 1] = {
                    username = row.username,
                    x = x,
                    y = y,
                    z = z,
                    status = USERNAME_LIST[row.username],
                    floor = type(row.floor) == "string"
                        and row.floor or nil,
                    outOfBounds = not isInsidePlayerSquare(x, z)
                }
            end
        end
    end

    remotePlayers[sender] = {
        players = snapshot,
        receivedAt = os.clock()
    }
end

local function getAllTracks()
    local tracks = {}
    local sableTracks = {}
    local seenPlayers = {}
    local seenSable = {}

    for _, radar in ipairs(radarMonitors) do
        local current = radar.getTracks() or {}
        for _, track in ipairs(current) do
            local category = track.category
            local id = track.id

            if category == CATEGORY_FILTER then
                if not id or id == "" or not seenPlayers[id] then
                    if id and id ~= "" then seenPlayers[id] = true end
                    tracks[#tracks + 1] = track
                end
            elseif category == "CONTRAPTION" or category == "SABLE" then
                if not id or id == "" or not seenSable[id] then
                    if id and id ~= "" then seenSable[id] = true end
                    sableTracks[#sableTracks + 1] = track
                end
            end
        end
    end

    return tracks, sableTracks
end

local function resolveTracks(tracks)
    -- Resolve uncached UUIDs concurrently. Cached names return immediately.
    local names = {}

    local function resolveOne(index, track)
        names[index] = resolveUsernameFromUUID(track.id or "")
    end

    if parallel and #tracks > 1 then
        local jobs = {}
        for i, track in ipairs(tracks) do
            jobs[#jobs + 1] = function()
                resolveOne(i, track)
            end
        end
        parallel.waitForAll(table.unpack(jobs))
    else
        for i, track in ipairs(tracks) do
            resolveOne(i, track)
        end
    end

    return names
end

local function buildLocalPlayers(tracks, names)
    local players = {}
    local flags = {
        mainDoorOpen = false,
        lockdownMainDoor = false,
        portalDoorOpen = false,
        speakerMatched = false,
        redstoneMatched = false,
        allyRelayMatched = false
    }

    for i, track in ipairs(tracks) do
        local username = names[i]
        if username then
            local status = USERNAME_LIST[username]
            local pos = track.position or {}
            local x = pos.x or 0
            local y = pos.y or 0
            local z = pos.z or 0

            if status == "enemy" and isInsidePlayerSquare(x, z) then
                flags.speakerMatched = true
            end

            if (status == "enemy" or status == nil)
                and isInsideArea(REDSTONE_DETECTION_AREA, x, y, z) then
                flags.redstoneMatched = true
                if status == "enemy" then
                    flags.lockdownMainDoor = true
                end
            end

            if status == "team" then
                if isInsideArea(MAIN_DOOR_OPEN_AREA, x, y, z) then
                    flags.mainDoorOpen = true
                elseif isInsideArea(REDSTONE_DETECTION_AREA, x, y, z) then
                    flags.mainDoorOpen = true
                elseif isInsideArea(PORTAL_DOOR_OPEN_AREA, x, y, z) then
                    flags.portalDoorOpen = true
                end
            end

            if (status == "ally" or status == "team")
                and isInsideAnyAllyRelayArea(x, y, z) then
                flags.allyRelayMatched = true
            end

            players[#players + 1] = {
                username = username,
                x = x,
                y = y,
                z = z,
                floor = isWithinFloorSquare(x, z)
                    and getPlayerFloor(y)
                    or nil,
                status = status,
                outOfBounds = not isInsidePlayerSquare(x, z)
            }
        end
    end

    return players, flags
end

local function mergeRemotePlayers(players)
    local detectedNames = {}

    for _, player in ipairs(players) do
        detectedNames[player.username:lower()] = true
    end

    local now = os.clock()

    for sender, remote in pairs(remotePlayers) do
        if now - remote.receivedAt > REMOTE_TIMEOUT then
            remotePlayers[sender] = nil
        else
            for _, player in ipairs(remote.players) do
                local key = player.username:lower()
                if not detectedNames[key] then
                    player.status = USERNAME_LIST[player.username]
                    players[#players + 1] = player
                    detectedNames[key] = true
                end
            end
        end
    end
end

local function getStatusPriority(status)
    if status == "enemy" then
        return 1
    elseif status == nil then
        return 2
    elseif status == "ally" then
        return 3
    elseif status == "team" then
        return 4
    end
    return 2
end

local function sortPlayers(players)
    table.sort(players, function(a, b)
        if a.outOfBounds ~= b.outOfBounds then
            return not a.outOfBounds
        end

        if a.outOfBounds and b.outOfBounds then
            local dxA = a.x - SQUARE_CENTER_X
            local dzA = a.z - SQUARE_CENTER_Z
            local dxB = b.x - SQUARE_CENTER_X
            local dzB = b.z - SQUARE_CENTER_Z
            local distanceA = dxA * dxA + dzA * dzA
            local distanceB = dxB * dxB + dzB * dzB

            if distanceA ~= distanceB then
                return distanceA < distanceB
            end
        end

        local priorityA = getStatusPriority(a.status)
        local priorityB = getStatusPriority(b.status)

        if priorityA ~= priorityB then
            return priorityA < priorityB
        end

        return a.username:lower() < b.username:lower()
    end)
end

local function buildRadarData(players)
    local data = {}

    for i, player in ipairs(players) do
        data[i] = {
            username = player.username,
            x = ("%.2f"):format(player.x),
            y = ("%.2f"):format(player.y),
            z = ("%.2f"):format(player.z),
            status = player.status,
            floor = player.floor,
            outOfBounds = player.outOfBounds
        }
    end

    return data
end

local function buildSableData(tracks)
    local data = {}
    for i, track in ipairs(tracks) do
        local pos = track.position or {}
        data[i] = {
            id = type(track.id) == "string" and track.id or nil,
            category = "SABLE",
            entityType = type(track.entityType) == "string" and track.entityType or nil,
            x = ("%.2f"):format(tonumber(pos.x) or 0),
            y = ("%.2f"):format(tonumber(pos.y) or 0),
            z = ("%.2f"):format(tonumber(pos.z) or 0)
        }
    end
    return data
end

local function publishState(players, flags, tracksCount, loopTimeMs)
    latestRadarData = buildRadarData(players)

    latestState = {
        timestamp = os.epoch("utc"),
        players = latestRadarData,
        sableContraptions = latestSableData,
        tracks = tracksCount,
        flags = flags,
        debug = DEBUG_TIMING and {
            loopTimeMs = loopTimeMs,
            avgLoopTimeMs = avgLoopTimeMs,
            maxLoopTimeMs = maxLoopTimeMs
        } or nil
    }

    local encoded = textutils.serialiseJSON(latestState)
    local file = fs.open(STATE_FILE, "w")
    if file then
        file.write(encoded)
        file.close()
    end
end

local function publishNetwork()
    if rednetEnabled then
        for _, destinationID in ipairs(DESTINATION_IDS) do
            rednet.send(destinationID, {
                data = latestRadarData,
                timestamp = os.epoch("utc")
            }, PROTOCOL)
        end
    end
end

local function websocketLoop()
    if not http or not http.websocket then
        while true do sleep(5) end
    end

    while not fs.exists("radar_stop") do
        if not radarWebSocket and os.clock() >= nextRadarReconnect then
            local ok, socketOrError = pcall(
                http.websocket,
                RADAR_WS_URL
            )

            if ok and socketOrError then
                radarWebSocket = socketOrError
            else
                nextRadarReconnect = os.clock() + 10
            end
        end

        if radarWebSocket and latestState.timestamp then
            local ok = pcall(function()
                radarWebSocket.send(
                    textutils.serialiseJSON({
                        type = "radar",
                        players = latestRadarData,
                        sableContraptions = latestSableData,
                        timestamp = latestState.timestamp
                    })
                )
            end)

            if not ok then
                pcall(function() radarWebSocket.close() end)
                radarWebSocket = nil
                nextRadarReconnect = os.clock() + 10
            end
        end

        sleep(0.25)
    end
end

local function rednetLoop()
    if not rednetEnabled then
        while true do sleep(5) end
    end

    if not rednet.isOpen(REDNET_SIDE) then
        rednet.open(REDNET_SIDE)
    end

    while not fs.exists("radar_stop") do
        local sender, message, protocol = rednet.receive(PROTOCOL)
        if sender and protocol == PROTOCOL then
            acceptRadarMessage(sender, message)
        end
    end
end

local function scanLoop()
    reloadDatabase(true)

    while not fs.exists("radar_stop") do
        local loopStart = os.clock()

        reloadDatabase(false)

        local tracks, sableTracks
        if #radarMonitors > 0 then
            tracks, sableTracks = getAllTracks()
        else
            tracks, sableTracks = {}, {}
        end

        local names = resolveTracks(tracks)
        local players, flags = buildLocalPlayers(tracks, names)

        mergeRemotePlayers(players)
        sortPlayers(players)
        latestSableData = buildSableData(sableTracks)
        publishNetwork()

        local loopTimeMs = (os.clock() - loopStart) * 1000
        maxLoopTimeMs = math.max(maxLoopTimeMs, loopTimeMs)
        loopSamples = loopSamples + 1
        avgLoopTimeMs =
            avgLoopTimeMs + (loopTimeMs - avgLoopTimeMs) / loopSamples

        publishState(players, flags, #tracks, loopTimeMs)

        sleep(RADAR_INTERVAL)
    end
end

print("RADAR: " .. #radarMonitors .. " radar monitor(s)")
print(rednetEnabled and "RADAR: rednet enabled" or "RADAR: rednet disabled")
print("RADAR: scanning every " .. RADAR_INTERVAL .. "s")
print("RADAR: loop timing debug enabled")

pcall(function()
    parallel.waitForAll(scanLoop, rednetLoop, websocketLoop)
end)
