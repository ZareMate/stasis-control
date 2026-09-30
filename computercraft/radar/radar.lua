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
local RAW_PROTOCOL = "radar_raw"
local RAW_HOSTNAME = "radar-" .. tostring(os.getComputerID())

local REDNET_SIDE = "bottom"

local RADAR_WS_URL = "wss://stasis.suchodupin.com/ws?role=radar&token=YOUR-STASIS_TOKEN"

local RADAR_INTERVAL = 0.10
local DB_RELOAD_INTERVAL = 1.0
local REMOTE_TIMEOUT = 10
local STATE_WRITE_INTERVAL = 0.20
local REDNET_LOOKUP_INTERVAL = 5
local USERNAME_LOOKUP_CONCURRENCY = 4

-- Debug timing
local DEBUG_TIMING = true
local maxLoopTimeMs = 0
local avgLoopTimeMs = 0
local loopSamples = 0

local areaHelper = dofile("area_helper.lua")
local floorHelper = dofile("floor_helper.lua")

local radarMonitors = { peripheral.find("create_radar:monitor") }
local modem = peripheral.wrap(REDNET_SIDE)
local rednetEnabled = modem
    and modem.isWireless
    and modem.isWireless()

local USERNAME_LIST = {}
local usernameHelper = dofile("username_helper.lua")
-- Local radar data is NEVER populated from rednet.
-- Remote radar data is kept separately so it can never be rebroadcast.
local remoteRadarData = {}
local latestRadarData = {}
local latestSableData = {}
local latestState = {}
local radarWebSocket = nil
local nextRadarReconnect = 0
local lastDatabaseLoad = 0
local lastStateWrite = 0
local rawRadarComputers = {}
local nextRednetLookup = 0

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

local function sanitizeRawTrack(track)
    if type(track) ~= "table" then
        return nil
    end

    local position = track.position or {}
    local x = tonumber(position.x)
    local y = tonumber(position.y)
    local z = tonumber(position.z)

    if not x or not y or not z then
        return nil
    end

    return {
        id = type(track.id) == "string" and track.id or nil,
        category = type(track.category) == "string" and track.category or nil,
        entityType = type(track.entityType) == "string" and track.entityType or nil,
        position = { x = x, y = y, z = z }
    }
end

local function buildRawTrackList(tracks)
    local data = {}

    for _, track in ipairs(tracks) do
        local raw = sanitizeRawTrack(track)

        if raw then
            data[#data + 1] = raw
        end
    end

    return data
end

local function acceptRawRadarMessage(sender, message)
    if type(message) ~= "table"
        or type(message.players) ~= "table" then
        return
    end

    -- REMOTE ONLY: this data is never included in publishRawNetwork().
    local snapshot = {}

    for _, track in ipairs(message.players) do
        local raw = sanitizeRawTrack(track)

        if raw and raw.category == CATEGORY_FILTER then
            snapshot[#snapshot + 1] = raw
        end
    end

    remoteRadarData[sender] = {
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
                    if id and id ~= "" then
                        seenPlayers[id] = true
                    end

                    tracks[#tracks + 1] = track
                end
            elseif category == "CONTRAPTION"
                or category == "SABLE" then

                if not id or id == "" or not seenSable[id] then
                    if id and id ~= "" then
                        seenSable[id] = true
                    end

                    sableTracks[#sableTracks + 1] = track
                end
            end
        end
    end

    return tracks, sableTracks
end

local function resolveTracks(tracks)
    -- Never block the radar scan on HTTP.
    -- Known names are returned immediately; unknown UUIDs are queued.
    local names = {}

    for i, track in ipairs(tracks) do
        local uuid = track.id or ""
        names[i] = usernameHelper.getCached(uuid)

        if not names[i] then
            usernameHelper.queueUUID(uuid)
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

            if status == "enemy" and areaHelper.isInsidePlayerSquare(x, z) then
                flags.speakerMatched = true
            end

            if (status == "enemy" or status == nil)
                and areaHelper.isInsideArea(areaHelper.AREAS.REDSTONE_DETECTION, x, y, z) then
                flags.redstoneMatched = true
                if status == "enemy" then
                    flags.lockdownMainDoor = true
                end
            end

            if status == "team" then
                if areaHelper.isInsideArea(areaHelper.AREAS.MAIN_DOOR_OPEN, x, y, z) then
                    flags.mainDoorOpen = true
                elseif areaHelper.isInsideArea(areaHelper.AREAS.REDSTONE_DETECTION, x, y, z) then
                    flags.mainDoorOpen = true
                elseif areaHelper.isInsideArea(areaHelper.AREAS.PORTAL_DOOR_OPEN, x, y, z) then
                    flags.portalDoorOpen = true
                end
            end

            if (status == "ally" or status == "team")
                and areaHelper.isInsideAnyAllyRelayArea(x, y, z) then
                flags.allyRelayMatched = true
            end

            players[#players + 1] = {
                username = username,
                x = x,
                y = y,
                z = z,
                floor = areaHelper.isInsideFloorSquare(x, z)
                    and floorHelper.getPlayerFloor(y)
                    or nil,
                status = status,
                outOfBounds = not areaHelper.isInsidePlayerSquare(x, z)
            }
        end
    end

    return players, flags
end

local function buildRemotePlayers(rawTracks)
    local players = {}
    local names = resolveTracks(rawTracks)

    for i, track in ipairs(rawTracks) do
        local username = names[i]

        if username then
            local status = USERNAME_LIST[username]
            local pos = track.position or {}
            local x = tonumber(pos.x) or 0
            local y = tonumber(pos.y) or 0
            local z = tonumber(pos.z) or 0

            players[#players + 1] = {
                username = username,
                x = x,
                y = y,
                z = z,
                floor = areaHelper.isInsideFloorSquare(x, z) and floorHelper.getPlayerFloor(y) or nil,
                status = status,
                outOfBounds = not areaHelper.isInsidePlayerSquare(x, z)
            }
        end
    end

    return players
end

local function mergeRemotePlayers(players)
    local detectedNames = {}

    for _, player in ipairs(players) do
        detectedNames[player.username:lower()] = true
    end

    local now = os.clock()

    for sender, remote in pairs(remoteRadarData) do
        if now - remote.receivedAt > REMOTE_TIMEOUT then
            remoteRadarData[sender] = nil
        else
            local remotePlayers = buildRemotePlayers(remote.players)

            for _, player in ipairs(remotePlayers) do
                local key = player.username:lower()

                if not detectedNames[key] then
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
            local dxA = a.x - areaHelper.SQUARE_CENTER_X
            local dzA = a.z - areaHelper.SQUARE_CENTER_Z
            local dxB = b.x - areaHelper.SQUARE_CENTER_X
            local dzB = b.z - areaHelper.SQUARE_CENTER_Z
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

local function publishState(players, flags, tracksCount, loopTimeMs, phases)
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
            maxLoopTimeMs = maxLoopTimeMs,
            phases = phases
        } or nil
    }

    local now = os.clock()

    -- GUI/redstone do not need a file rewrite every scan.
    if now - lastStateWrite < STATE_WRITE_INTERVAL then
        return
    end

    lastStateWrite = now

    local encoded = textutils.serialiseJSON(latestState)
    local file = fs.open(STATE_FILE, "w")
    if file then
        file.write(encoded)
        file.close()
    end
end

local function publishRawNetwork(localTracks)
    if not rednetEnabled then
        return
    end

    local now = os.clock()

    if now >= nextRednetLookup then
        rawRadarComputers = { rednet.lookup(RAW_PROTOCOL) }
        nextRednetLookup = now + REDNET_LOOKUP_INTERVAL
    end

    local payload = {
        source = os.getComputerID(),
        timestamp = os.epoch("utc"),
        players = buildRawTrackList(localTracks)
    }

    for _, computer in ipairs(rawRadarComputers) do
        -- Never send back to ourselves.
        if computer ~= os.getComputerID() then
            rednet.send(computer, payload, RAW_PROTOCOL)
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

    -- Advertise this computer as a raw radar source.
    rednet.host(RAW_PROTOCOL, RAW_HOSTNAME)

    while not fs.exists("radar_stop") do
        -- Use a timeout so radar_stop can shut this worker down.
        local sender, message, protocol =
            rednet.receive(RAW_PROTOCOL, 0.5)

        if sender and protocol == RAW_PROTOCOL then
            acceptRawRadarMessage(sender, message)
        end
    end
end

local function scanLoop()
    reloadDatabase(true)

    while not fs.exists("radar_stop") do
        local loopStart = os.clock()
        local phaseStart = loopStart
        local phases = {}

        reloadDatabase(false)
        phases.databaseMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        local tracks, sableTracks
        if #radarMonitors > 0 then
            tracks, sableTracks = getAllTracks()
        else
            tracks, sableTracks = {}, {}
        end
        phases.getTracksMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        local names = resolveTracks(tracks)
        phases.usernameQueueMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        local players, flags = buildLocalPlayers(tracks, names)
        phases.localBuildMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        mergeRemotePlayers(players)
        phases.remoteMergeMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        sortPlayers(players)
        phases.sortMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        latestSableData = buildSableData(sableTracks)
        phases.sableMs = (os.clock() - phaseStart) * 1000

        phaseStart = os.clock()
        -- Only tracks read from THIS computer's wired radar monitors are broadcast.
        -- Remote tracks stay in remoteRadarData and can never be rebroadcast.
        publishRawNetwork(tracks)
        phases.rawNetworkMs = (os.clock() - phaseStart) * 1000

        local loopTimeMs = (os.clock() - loopStart) * 1000
        maxLoopTimeMs = math.max(maxLoopTimeMs, loopTimeMs)
        loopSamples = loopSamples + 1
        avgLoopTimeMs =
            avgLoopTimeMs + (loopTimeMs - avgLoopTimeMs) / loopSamples

        publishState(players, flags, #tracks, loopTimeMs, phases)

        sleep(RADAR_INTERVAL)
    end
end

print("RADAR: " .. #radarMonitors .. " radar monitor(s)")
print(rednetEnabled and "RADAR: rednet enabled" or "RADAR: rednet disabled")
print("RADAR: raw rednet protocol = " .. RAW_PROTOCOL)
print("RADAR: raw hostname = " .. RAW_HOSTNAME)
print("RADAR: scanning every " .. RADAR_INTERVAL .. "s")
print("RADAR: loop timing debug enabled")

local function runWorker(name, worker)
    while true do
        local ok, err = pcall(worker)

        if ok then
            print("RADAR: " .. name .. " stopped")
            return
        end

        printError("RADAR: " .. name .. " crashed:")
        printError(err)

        local file = fs.open("radar_error.log", "a")
        if file then
            file.writeLine(
                os.date("%Y-%m-%d %H:%M:%S")
                    .. " [" .. name .. "] "
                    .. tostring(err)
            )
            file.close()
        end

        sleep(1)
    end
end

parallel.waitForAll(
    function() runWorker("SCAN", scanLoop) end,
    function() runWorker("USERNAME", function()
        usernameHelper.worker(USERNAME_LOOKUP_CONCURRENCY)
    end) end,
    function() runWorker("REDNET", rednetLoop) end,
    function() runWorker("WEBSOCKET", websocketLoop) end
)
