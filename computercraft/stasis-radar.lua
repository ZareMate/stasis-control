-- Stasis Control - radar process
-- Create Radar is the authoritative source for chamber readiness.
-- This process runs independently from the pulling process.

local DISPLAY_REFRESH = 0.5
local PULLED_DISPLAY_TIME = 5

local MONITOR = peripheral.find("monitor")
local RADAR = peripheral.wrap("top")
local RADAR_ENTITY = "entity.minecraft.ender_pearl"
local RADAR_BLOCK_EPSILON = 0.001

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
    [1] = { x = -96, y = 30, z = 258 },
    [2] = { x = -94, y = 30, z = 258 },
    [3] = { x = -92, y = 30, z = 258 },
    [4] = { x = -90, y = 30, z = 258 },
    [5] = { x = -88, y = 30, z = 258 },
    [6] = { x = -86, y = 30, z = 258 },
    [7] = { x = -84, y = 30, z = 258 },
    [8] = { x = -82, y = 30, z = 258 },
    [9] = { x = -80, y = 30, z = 258 },
    [10] = { x = -78, y = 30, z = 258 },
    [11] = { x = -76, y = 30, z = 258 },
    [12] = { x = -74, y = 30, z = 258 }
}

local chambers = {}
local pulledUntil = {}
local lastSentStatus = {}
local wsConnected = false
local lastError = nil
local lastTrackCount = 0

local function inTwoBlocks(value, start)
    local block = math.floor(value + RADAR_BLOCK_EPSILON)
    return block == start or block == start + 1
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

    for _, track in pairs(tracks or {}) do
        if track and track.entityType == RADAR_ENTITY then
            local p = track.position

            if p and p.x ~= nil and p.y ~= nil and p.z ~= nil then
                local x = tonumber(p.x)
                local y = tonumber(p.y)
                local z = tonumber(p.z)

                if x and y and z and
                   inTwoBlocks(x, position.x) and
                   inTwoBlocks(y, position.y - 1) and
                   inTwoBlocks(z, position.z) then
                    return true
                end
            end
        end
    end

    return false
end

local function detectAll(tracks)
    local result = {}

    for _, relay in ipairs(RELAYS) do
        result[relay.chamber] = pearlDetectedAt(
            relay.chamber,
            tracks
        )
    end

    return result
end

local function render()
    if not MONITOR then
        return
    end

    local width, height = MONITOR.getSize()

    MONITOR.setBackgroundColor(colors.black)
    MONITOR.clear()
    MONITOR.setTextScale(1)
    MONITOR.setCursorPos(1, 1)

    local function line(text, color)
        local _, y = MONITOR.getCursorPos()

        if y > height then
            return
        end

        MONITOR.setTextColor(color or colors.white)
        MONITOR.write(
            tostring(text):sub(1, width)
        )

        if y < height then
            MONITOR.setCursorPos(1, y + 1)
        end
    end

    local title = "STASIS RADAR"

    MONITOR.setCursorPos(
        math.max(
            1,
            math.floor((width - #title) / 2) + 1
        ),
        1
    )

    MONITOR.setTextColor(colors.orange)
    MONITOR.write(title)

    line(
        "WS: " ..
        (wsConnected and "CONNECTED" or "DISCONNECTED"),
        wsConnected and colors.lime or colors.red
    )

    line(
        "Radar: " ..
        (RADAR and "FOUND" or "MISSING"),
        RADAR and colors.lime or colors.red
    )

    line(
        "Tracks: " .. tostring(lastTrackCount)
    )

    local ready = 0
    local pulling = 0
    local pulled = 0
    local empty = 0
    local unknown = 0

    for _, relay in ipairs(RELAYS) do
        local entry = chambers[relay.chamber]

        if not entry then
            unknown = unknown + 1
        elseif entry.status == "ready" then
            ready = ready + 1
        elseif entry.status == "pulling" then
            pulling = pulling + 1
        elseif entry.status == "pulled" then
            pulled = pulled + 1
        elseif entry.status == "empty" then
            empty = empty + 1
        else
            unknown = unknown + 1
        end
    end

    line(
        "C:" .. #RELAYS ..
        " R:" .. ready ..
        " P:" .. pulling ..
        " D:" .. pulled ..
        " E:" .. empty ..
        " U:" .. unknown
    )

    line(string.rep("-", width), colors.gray)

    for _, relay in ipairs(RELAYS) do
        if MONITOR.getCursorPos() <= height then
            local entry = chambers[relay.chamber] or {
                player = relay.player,
                status = "unknown"
            }

            local status = tostring(entry.status or "unknown")

            local statusColor =
                status == "ready" and colors.lime or
                status == "pulling" and colors.orange or
                status == "pulled" and colors.yellow or
                status == "empty" and colors.red or
                colors.white

            MONITOR.setTextColor(statusColor)

            local text =
                string.format("%02d ", relay.chamber) ..
                tostring(entry.player or relay.player) ..
                " " ..
                string.upper(status)

            MONITOR.write(text:sub(1, width))

            local _, y = MONITOR.getCursorPos()

            if y < height then
                MONITOR.setCursorPos(1, y + 1)
            end
        end
    end

    if lastError then
        local _, y = MONITOR.getCursorPos()

        if y <= height then
            MONITOR.setCursorPos(1, y)
            MONITOR.setTextColor(colors.red)
            MONITOR.write(
                ("ERR: " .. lastError):sub(1, width)
            )
        end
    end
end

local function setStatus(
    chamber,
    player,
    status,
    label,
    sendToServer
)
    chamber = tonumber(chamber)

    if not chamber then
        return
    end

    local entry = chambers[chamber] or {
        player = player or "",
        label =
            label or
            ("Chamber " ..
             string.format("%02d", chamber)),
        status = "unknown"
    }

    if player and player ~= "" then
        entry.player = player
    end

    if label and label ~= "" then
        entry.label = label
    end

    entry.status = status
    entry.statusSince = os.epoch("utc")
    chambers[chamber] = entry

    if sendToServer then
        if lastSentStatus[chamber] ~= status then
            lastSentStatus[chamber] = status

            os.queueEvent(
                "stasis_status",
                {
                    source = "radar",
                    chamber = chamber,
                    player = entry.player or "",
                    label = entry.label,
                    status = status
                }
            )
        end
    end

    render()
end

local function sendAllCurrentStatus()
    for _, relay in ipairs(RELAYS) do
        local chamber = relay.chamber
        local entry = chambers[chamber]

        if entry then
            lastSentStatus[chamber] = nil

            setStatus(
                chamber,
                entry.player or relay.player,
                entry.status,
                entry.label,
                true
            )
        end
    end
end

local function syncAll(force)
    local tracks, err = getPearlTracks()

    if not tracks then
        lastError = "Radar: " .. tostring(err)
        render()
        return
    end

    lastError = nil
    lastTrackCount = 0

    for _ in pairs(tracks) do
        lastTrackCount = lastTrackCount + 1
    end

    local detected = detectAll(tracks)
    local now = os.epoch("utc")

    for _, relay in ipairs(RELAYS) do
        local chamber = relay.chamber
        local entry = chambers[chamber]

        if not entry then
            setStatus(
                chamber,
                relay.player,
                "unknown",
                "Chamber " ..
                string.format("%02d", chamber),
                false
            )

            entry = chambers[chamber]
        end

        local newStatus = nil

        if entry.status == "pulling" then
            -- Keep showing PULLING while the pearl is still present.
            -- As soon as Radar sees the pearl leave, finalize the pull
            -- ourselves. This makes the Radar process independent from
            -- whether the pulling shell's "pulled" event is received.
            if not detected[chamber] then
                newStatus = "pulled"
                pulledUntil[chamber] =
                    now +
                    (PULLED_DISPLAY_TIME * 1000)
            end

        elseif entry.status == "pulled" then
            -- Keep the temporary PULLED state for the configured display
            -- time, then immediately return to live Radar detection.
            if not pulledUntil[chamber] or now >= pulledUntil[chamber] then
                newStatus =
                    detected[chamber] and
                    "ready" or
                    "empty"

                pulledUntil[chamber] = nil
            end

        else
            newStatus =
                detected[chamber] and
                "ready" or
                "empty"
        end

        if force and entry.status ~= "pulling" then
            if entry.status ~= newStatus then
                newStatus =
                    detected[chamber] and
                    "ready" or
                    "empty"
            end
        end

        if newStatus and entry.status ~= newStatus then
            setStatus(
                chamber,
                entry.player or relay.player,
                newStatus,
                entry.label,
                true
            )
        end
    end

    render()
end

local function handleStatusMessage(message)
    if not message then
        return
    end

    if message.source ~= "pulling" then
        return
    end

    local chamber = tonumber(message.chamber)

    if not chamber then
        return
    end

    local entry = chambers[chamber] or {
        player = message.player or "",
        label =
            message.label or
            ("Chamber " ..
             string.format("%02d", chamber)),
        status = "unknown"
    }

    entry.player = message.player or entry.player
    entry.label = message.label or entry.label
    entry.status = message.status
    entry.statusSince = os.epoch("utc")
    chambers[chamber] = entry

    if message.status == "pulled" then
        pulledUntil[chamber] =
            os.epoch("utc") +
            (PULLED_DISPLAY_TIME * 1000)
    elseif message.status ~= "pulling" then
        pulledUntil[chamber] = nil
    end

    render()
end

print("==============================")
print("      STASIS CONTROL")
print("          RADAR")
print("==============================")
print("Radar: " .. (RADAR and "found" or "missing"))
print("Monitor: " .. (MONITOR and "found" or "missing"))
print("")

local radarTimer = os.startTimer(DISPLAY_REFRESH)

while true do
    local event, a = os.pullEvent()

    if event == "stasis_ws_connected" then
        wsConnected = true
        print("[RADAR] WS connected")
        syncAll(true)
        sendAllCurrentStatus()

    elseif event == "stasis_ws_disconnected" then
        wsConnected = false
        render()

    elseif event == "stasis_request_sync" then
        syncAll(true)
        sendAllCurrentStatus()

    elseif event == "stasis_status" then
        handleStatusMessage(a)

    elseif event == "timer" then
        if a == radarTimer then
            syncAll(false)
            radarTimer = os.startTimer(DISPLAY_REFRESH)
        end

    elseif event == "stasis_shutdown" then
        return

    elseif event == "terminate" then
        os.queueEvent("stasis_shutdown")
        return
    end

    render()
end
