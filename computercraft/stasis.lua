-- Stasis Control ComputerCraft controller
-- One controller should run for each base.
--
-- Base/chamber/player data is sent through WebSocket status reports.
-- The server does not use a static chamber configuration file.

local SERVER = "wss://stasis.suchodupin.com/ws"
local TOKEN = "YOUR_STASIS_TOKEN"
local CONTROLLER_NAME = "base-1"
local BASE_ID = 1

local PULSE_TIME = 1
local HEARTBEAT_INTERVAL = 10
local HEARTBEAT_TIMEOUT = 5
local DISPLAY_REFRESH = 1
local PULLED_DISPLAY_TIME = 5

local MONITOR = peripheral.find("monitor")
local RADAR = peripheral.wrap("top")
local RADAR_ENTITY = "minecraft:ender_pearl"
local RADAR_POSITION_TOLERANCE = 1

local RELAYS = {
    { chamber = 1, player = "Piotrusek69", relay = "redstone_relay_20" },
    { chamber = 2, player = "Shark107", relay = "redstone_relay_21" },
    { chamber = 3, player = "ZareMate", relay = "redstone_relay_22" },
    { chamber = 4, player = "4e6qr", relay = "redstone_relay_23" },
    { chamber = 5, player = "GRI_9", relay = "redstone_relay_24" },
    { chamber = 6, player = "Armadillo122", relay = "redstone_relay_25" },
    { chamber = 7, player = "FcFabio", relay = "redstone_relay_26" },
    { chamber = 8, player = "M1stak3en", relay = "redstone_relay_27" },
    { chamber = 9, player = "EnderiumEnd", relay = "redstone_relay_28" },
    { chamber = 10, player = "Remoteless", relay = "redstone_relay_29" },
    { chamber = 11, player = "netramen7", relay = "redstone_relay_30" },
    { chamber = 12, player = "gardja", relay = "redstone_relay_31" }
}

local CHAMBER_POSITIONS = {
    [1] = { x = -96, y = 30, z = 268 },
    [2] = { x = -94, y = 30, z = 267 },
    [3] = { x = -92, y = 30, z = 266 },
    [4] = { x = -90, y = 30, z = 265 },
    [5] = { x = -88, y = 30, z = 264 },
    [6] = { x = -86, y = 30, z = 263 },
    [7] = { x = -84, y = 30, z = 262 },
    [8] = { x = -82, y = 30, z = 261 },
    [9] = { x = -80, y = 30, z = 260 },
    [10] = { x = -78, y = 30, z = 259 },
    [11] = { x = -76, y = 30, z = 258 },
    [12] = { x = -74, y = 30, z = 258 }
}

local chambers = {}
local wsConnected = false

local setChamberStatus
local sendStatus
local heartbeatPending = false
local heartbeatSentAt = 0
local lastHeartbeatAck = 0
local heartbeatId = 0
local lastError = nil

local function encode(value)
    return textutils.urlEncode(tostring(value))
end

local function findRelay(player)
    for _, entry in ipairs(RELAYS) do
        if string.lower(entry.player) == string.lower(player) then
            return entry
        end
    end

    return nil
end

local function getRelayPeripheral(name)
    if not peripheral.isPresent(name) then
        return nil, "Peripheral not found: " .. name
    end

    local peripheralType = peripheral.getType(name)

    if peripheralType ~= "redstone_relay" then
        return nil,
            "Peripheral " .. name .. " is " ..
            tostring(peripheralType) ..
            ", not redstone_relay"
    end

    return peripheral.wrap(name)
end

local function sendMessage(ws, message)
    local ok, err = pcall(function()
        ws.send(textutils.serializeJSON(message))
    end)

    if not ok then
        lastError = tostring(err)
        print("WebSocket send failed: " .. lastError)
        return false
    end

    return true
end

local function statusColor(status)
    if not MONITOR then
        return colors.white
    end

    if status == "ready" then
        return colors.lime
    elseif status == "pulling" then
        return colors.orange
    elseif status == "pulled" then
        return colors.yellow
    elseif status == "empty" then
        return colors.red
    end

    return colors.white
end

local function fit(text, width)
    text = tostring(text or "")

    if #text > width then
        return string.sub(text, 1, math.max(0, width - 1)) .. "…"
    end

    return text .. string.rep(" ", width - #text)
end

local function drawMonitor()
    if not MONITOR then
        return
    end

    local width, height = MONITOR.getSize()

    MONITOR.setBackgroundColor(colors.black)
    MONITOR.clear()
    MONITOR.setTextScale(1)
    MONITOR.setCursorPos(1, 1)

    local function writeLine(line, color)
        local _, y = MONITOR.getCursorPos()

        if y > height then
            return
        end

        MONITOR.setTextColor(color or colors.white)
        MONITOR.write(fit(line, width))

        if y < height then
            MONITOR.setCursorPos(1, y + 1)
        end
    end

    local title = "STASIS CONTROL"
    local titleX = math.max(1, math.floor((width - #title) / 2) + 1)

    MONITOR.setCursorPos(titleX, 1)
    MONITOR.setTextColor(colors.orange)
    MONITOR.write(title)

    MONITOR.setCursorPos(1, 2)
    writeLine("Base: " .. tostring(BASE_ID) .. "  " .. CONTROLLER_NAME)

    MONITOR.setCursorPos(1, 3)
    writeLine(
        "WS:   " .. (wsConnected and "CONNECTED" or "DISCONNECTED"),
        wsConnected and colors.lime or colors.red
    )

    local heartbeatText = "WAITING"

    if heartbeatPending then
        heartbeatText = "CHECKING"
    elseif lastHeartbeatAck > 0 then
        local age = math.max(
            0,
            math.floor((os.epoch("utc") - lastHeartbeatAck) / 1000)
        )
        heartbeatText = "OK " .. tostring(age) .. "s"
    end

    MONITOR.setCursorPos(1, 4)
    writeLine(
        "HB:   " .. heartbeatText,
        wsConnected and colors.lime or colors.red
    )

    local ready = 0
    local pulling = 0
    local pulled = 0
    local empty = 0

    for _, entry in pairs(chambers) do
        if entry.status == "ready" then
            ready = ready + 1
        elseif entry.status == "pulling" then
            pulling = pulling + 1
        elseif entry.status == "pulled" then
            pulled = pulled + 1
        elseif entry.status == "empty" then
            empty = empty + 1
        end
    end

    MONITOR.setCursorPos(1, 5)
    writeLine(
        "C:" .. tostring(#RELAYS) ..
        " R:" .. tostring(ready) ..
        " P:" .. tostring(pulling) ..
        " D:" .. tostring(pulled) ..
        " E:" .. tostring(empty)
    )

    MONITOR.setCursorPos(1, 6)
    writeLine(string.rep("-", width), colors.gray)

    local row = 7

    for _, relay in ipairs(RELAYS) do
        if row > height then
            break
        end

        local chamber = chambers[relay.chamber] or {
            player = relay.player,
            status = "unknown"
        }

        local prefix = string.format("%02d ", relay.chamber)
        local nameWidth = math.max(1, width - #prefix - 8)

        local line =
            prefix ..
            fit(chamber.player or relay.player, nameWidth) ..
            " " ..
            string.upper(string.sub(chamber.status or "unknown", 1, 7))

        MONITOR.setCursorPos(1, row)
        MONITOR.setTextColor(statusColor(chamber.status))
        MONITOR.write(fit(line, width))

        row = row + 1
    end

    if lastError and row <= height then
        MONITOR.setCursorPos(1, row)
        MONITOR.setTextColor(colors.red)
        MONITOR.write(fit("ERR: " .. lastError, width))
    end
end

local function getPearlTracks()
    if not RADAR or not RADAR.getTracks then
        return nil, "Create Radar monitor not found on top"
    end

    local ok, tracks = pcall(function()
        return RADAR.getTracks()
    end)

    if not ok then
        return nil, tostring(tracks)
    end

    if type(tracks) ~= "table" then
        return nil, "Radar returned invalid track data"
    end

    return tracks
end

local function pearlDetectedAt(chamber, tracks)
    local position = CHAMBER_POSITIONS[chamber]

    if not position then
        return false
    end

    for _, track in pairs(tracks) do
        if track and track.entityType == RADAR_ENTITY then
            local p = track.position

            if p and
               p.x ~= nil and
               p.y ~= nil and
               p.z ~= nil then
                local dx = math.abs(tonumber(p.x) - position.x)
                local dy = math.abs(tonumber(p.y) - position.y)
                local dz = math.abs(tonumber(p.z) - position.z)

                if dx <= RADAR_POSITION_TOLERANCE and
                   dy <= RADAR_POSITION_TOLERANCE and
                   dz <= RADAR_POSITION_TOLERANCE then
                    return true
                end
            end
        end
    end

    return false
end

local function syncChamberWithRadar(ws, chamber, force)
    local entry = chambers[chamber]

    if not entry then
        return
    end

    if not force and (
        entry.status == "pulling" or
        entry.status == "pulled"
    ) then
        return
    end

    local tracks, err = getPearlTracks()

    if not tracks then
        lastError = "Radar: " .. err
        return
    end

    local detected = pearlDetectedAt(chamber, tracks)
    local newStatus = detected and "ready" or "empty"

    if entry.status == newStatus then
        return
    end

    local player = entry.player or ""

    setChamberStatus(chamber, player, newStatus)
    sendStatus(ws, chamber, player, newStatus)
end

local function syncAllChambersWithRadar(ws)
    local tracks, err = getPearlTracks()

    if not tracks then
        lastError = "Radar: " .. err
        return
    end

    for _, relay in ipairs(RELAYS) do
        local chamber = relay.chamber
        local entry = chambers[chamber]

        if entry and
           entry.status ~= "pulling" and
           entry.status ~= "pulled" then
            local detected = pearlDetectedAt(chamber, tracks)
            local newStatus = detected and "ready" or "empty"

            if entry.status ~= newStatus then
                local player = entry.player or ""

                setChamberStatus(
                    chamber,
                    player,
                    newStatus
                )

                sendStatus(
                    ws,
                    chamber,
                    player,
                    newStatus
                )
            end
        end
    end
end

local function clearPulledStatus(chamber)
    local entry = chambers[chamber]

    if entry and entry.status == "pulled" then
        local player = entry.player

        entry.status = "ready"
        entry.statusSince = os.epoch("utc")
        entry.pulledUntil = nil
        entry.pulledTimer = nil

        return player
    end

    return nil
end

function setChamberStatus(chamber, player, status, label)
    chamber = tonumber(chamber)

    if not chamber then
        return
    end

    local entry = chambers[chamber] or {
        player = player or "",
        label = label or ("Chamber " .. string.format("%02d", chamber)),
        status = "empty"
    }

    if player ~= nil and player ~= "" then
        entry.player = player
    end

    if label and label ~= "" then
        entry.label = label
    end

    entry.status = status
    entry.statusSince = os.epoch("utc")
    chambers[chamber] = entry

    if status == "pulled" then
        entry.pulledUntil = os.epoch("utc") + (PULLED_DISPLAY_TIME * 1000)
        entry.pulledTimer = os.startTimer(PULLED_DISPLAY_TIME)
    else
        entry.pulledUntil = nil
        entry.pulledTimer = nil
    end

    drawMonitor()
end

function sendStatus(ws, chamber, player, status)
    return sendMessage(ws, {
        type = "status",
        base = BASE_ID,
        baseName = "Base " .. tostring(BASE_ID),
        chamber = chamber,
        label = "Chamber " .. string.format("%02d", chamber),
        player = player or "",
        status = status
    })
end

local function pulseRelay(relayName)
    local relay, err = getRelayPeripheral(relayName)

    if not relay then
        print(err)
        return false, err
    end

    local ok, pulseError = pcall(function()
        relay.setOutput("front", true)
        sleep(PULSE_TIME)
        relay.setOutput("front", false)
    end)

    if not ok then
        print("Relay error: " .. tostring(pulseError))
        return false, pulseError
    end

    return true
end

local function handlePull(ws, command)
    local chamber = tonumber(command.chamber)
    local player = tostring(command.player or "")
    local requestId = tostring(command.requestId or "")

    if not chamber or player == "" then
        sendMessage(ws, {
            type = "pull-result",
            chamber = chamber,
            player = player,
            requestId = requestId,
            success = false,
            error = "Pull command is missing chamber or player"
        })
        return
    end

    if command.base ~= nil and tonumber(command.base) ~= BASE_ID then
        return
    end

    local entry = findRelay(player)

    if not entry then
        print(
            "No relay configured for player " ..
            player ..
            " (chamber " ..
            chamber ..
            ")"
        )

        setChamberStatus(chamber, player, "ready")
        sendStatus(ws, chamber, player, "ready")

        sendMessage(ws, {
            type = "pull-result",
            chamber = chamber,
            player = player,
            requestId = requestId,
            success = false,
            error = "No relay configured for player " .. player
        })
        return
    end

    print("")
    print("Pull request")
    print("  Player:  " .. player)
    print("  Chamber: " .. chamber)
    print("  Relay:   " .. entry.relay)

    setChamberStatus(chamber, player, "pulling")
    sendStatus(ws, chamber, player, "pulling")

    local success, pulseError = pulseRelay(entry.relay)

    if success then
        setChamberStatus(chamber, player, "pulled")
        sendStatus(ws, chamber, player, "pulled")

        sendMessage(ws, {
            type = "pull-result",
            chamber = chamber,
            player = player,
            requestId = requestId,
            success = true
        })

        print("  Result:  pulled")
    else
        setChamberStatus(chamber, player, "ready")
        sendStatus(ws, chamber, player, "ready")

        sendMessage(ws, {
            type = "pull-result",
            chamber = chamber,
            player = player,
            requestId = requestId,
            success = false,
            error = tostring(pulseError)
        })

        print("  Result:  relay failed")
    end
end

local function announceConfiguredPlayers(ws)
    for _, entry in ipairs(RELAYS) do
        local relay = getRelayPeripheral(entry.relay)

        if relay then
            print(
                "Configured: " ..
                entry.player ..
                " -> " ..
                entry.relay
            )

            setChamberStatus(
                entry.chamber,
                entry.player,
                "unknown"
            )
        else
            print(
                "Missing relay: " ..
                entry.relay ..
                " for " ..
                entry.player
            )

            setChamberStatus(
                entry.chamber,
                entry.player,
                "empty"
            )

            sendStatus(
                ws,
                entry.chamber,
                entry.player,
                "empty"
            )
        end
    end
end

local function connect()
    local url =
        SERVER ..
        "?role=controller" ..
        "&name=" .. encode(CONTROLLER_NAME) ..
        "&base=" .. encode(BASE_ID) ..
        "&token=" .. encode(TOKEN)

    return http.websocket(url)
end

local function sendHeartbeat(ws)
    heartbeatId = heartbeatId + 1
    heartbeatSentAt = os.epoch("utc")
    heartbeatPending = true

    return sendMessage(ws, {
        type = "heartbeat",
        id = heartbeatId
    })
end

while true do
    term.clear()
    term.setCursorPos(1, 1)

    print("================================")
    print("          STASIS CONTROL")
    print("================================")
    print("Controller: " .. CONTROLLER_NAME)
    print("Base:       " .. tostring(BASE_ID))
    print("Server:     " .. SERVER)
    print("Monitor:    " .. (MONITOR and "found" or "not found"))
    print("Radar:      " .. (RADAR and "found" or "not found"))
    print("")

    wsConnected = false
    heartbeatPending = false
    drawMonitor()

    local ws, err = connect()

    if not ws then
        lastError = tostring(err)
        drawMonitor()

        print("Connection failed: " .. lastError)
        print("Retrying in 5 seconds...")
        sleep(5)
    else
        wsConnected = true
        heartbeatPending = false
        lastHeartbeatAck = 0
        lastError = nil

        print("Connected to Stasis Control")
        print("")

        drawMonitor()
        announceConfiguredPlayers(ws)
        syncAllChambersWithRadar(ws)
        sendHeartbeat(ws)

        local heartbeatTimer = os.startTimer(HEARTBEAT_INTERVAL)
        local heartbeatCheckTimer = os.startTimer(1)
        local displayTimer = os.startTimer(DISPLAY_REFRESH)

        while true do
            local event, a, b = os.pullEvent()

            if event == "websocket_message" then
                local messageText = b

                local ok, message = pcall(
                    textutils.unserializeJSON,
                    messageText
                )

                if ok and message then
                    if message.type == "pull" then
                        handlePull(ws, message)

                    elseif message.type == "heartbeat-ack" then
                        if message.id == heartbeatId or message.id == nil then
                            heartbeatPending = false
                            lastHeartbeatAck = os.epoch("utc")
                            lastError = nil
                            drawMonitor()
                        end
                    end
                end

            elseif event == "websocket_closed" then
                wsConnected = false
                heartbeatPending = false
                lastError = "WebSocket closed"
                drawMonitor()
                print("Connection closed")
                break

            elseif event == "timer" then
                if a == heartbeatTimer then
                    heartbeatTimer = os.startTimer(HEARTBEAT_INTERVAL)

                    if heartbeatPending then
                        lastError = "Heartbeat timeout"
                        print("Heartbeat timeout")
                        wsConnected = false
                        heartbeatPending = false

                        pcall(function()
                            ws.close()
                        end)

                        drawMonitor()
                        break
                    end

                    if not sendHeartbeat(ws) then
                        wsConnected = false

                        pcall(function()
                            ws.close()
                        end)

                        drawMonitor()
                        break
                    end

                elseif a == heartbeatCheckTimer then
                    heartbeatCheckTimer = os.startTimer(1)

                    if heartbeatPending and
                       os.epoch("utc") - heartbeatSentAt > (HEARTBEAT_TIMEOUT * 1000) then
                        lastError = "Heartbeat timeout"
                        print("Heartbeat timeout")
                        wsConnected = false
                        heartbeatPending = false

                        pcall(function()
                            ws.close()
                        end)

                        drawMonitor()
                        break
                    end

                elseif a == displayTimer then
                    for chamber, entry in pairs(chambers) do
                        if entry.status == "pulled" and
                           entry.pulledUntil and
                           os.epoch("utc") >= entry.pulledUntil then
                            local player = clearPulledStatus(chamber)

                            if player then
                                local tracks = getPearlTracks()

                                if tracks then
                                    local detected = pearlDetectedAt(
                                        chamber,
                                        tracks
                                    )

                                    local status = detected and "ready" or "empty"

                                    setChamberStatus(
                                        chamber,
                                        player,
                                        status
                                    )

                                    sendStatus(
                                        ws,
                                        chamber,
                                        player,
                                        status
                                    )
                                else
                                    lastError = "Radar unavailable after pulled timer"
                                    sendStatus(
                                        ws,
                                        chamber,
                                        player,
                                        "ready"
                                    )
                                end
                            end
                        end
                    end

                    syncAllChambersWithRadar(ws)
                    drawMonitor()
                    displayTimer = os.startTimer(DISPLAY_REFRESH)

                else
                    for chamber, entry in pairs(chambers) do
                        if entry.pulledTimer == a then
                            local player = clearPulledStatus(chamber)

                            if player then
                                local tracks = getPearlTracks()

                                if tracks then
                                    local detected = pearlDetectedAt(
                                        chamber,
                                        tracks
                                    )

                                    local status = detected and "ready" or "empty"

                                    setChamberStatus(
                                        chamber,
                                        player,
                                        status
                                    )

                                    sendStatus(
                                        ws,
                                        chamber,
                                        player,
                                        status
                                    )
                                else
                                    lastError = "Radar unavailable after pulled timer"
                                    sendStatus(
                                        ws,
                                        chamber,
                                        player,
                                        "ready"
                                    )
                                end
                            end

                            drawMonitor()
                        end
                    end
                end
            end
        end

        pcall(function()
            ws.close()
        end)

        wsConnected = false
        heartbeatPending = false
        drawMonitor()

        print("Reconnecting in 2 seconds...")
        sleep(2)
    end
end