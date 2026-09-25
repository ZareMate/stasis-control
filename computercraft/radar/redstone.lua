-- =========================================================
-- RADAR REDSTONE / ALARM PROCESS
-- =========================================================
-- This process does ONLY redstone relays + alarm speaker.
-- It reads radar_state.json written by radar.lua.

local STATE_FILE = "radar_state.json"
local REDSTONE_SIDE = "top"
local REDSTONE_INTERVAL = 0.05
local SPEAKER_COOLDOWN = 0.5
local DEBUG_TIMING = true
local maxLoopTimeMs = 0
local avgLoopTimeMs = 0
local loopSamples = 0

local FLOOR_RELAYS = {
    TOP = peripheral.wrap("redstone_relay_52"),
    PWR = peripheral.wrap("redstone_relay_42"),
    NWF = peripheral.wrap("redstone_relay_43"),
    SRV = peripheral.wrap("redstone_relay_44"),
    MAIN = peripheral.wrap("redstone_relay_45"),
    MCH = peripheral.wrap("redstone_relay_46"),
    LAVA = peripheral.wrap("redstone_relay_47"),
    MINE = peripheral.wrap("redstone_relay_48")
}

local DOOR_MAIN_OPENER_RELAY =
    peripheral.wrap("redstone_relay_49")

local DOOR_PORTAL_OPENER_RELAY =
    peripheral.wrap("redstone_relay_51")

local speakers = {peripheral.find("speaker")}

local FLOOR_ORDER = {
    "TOP", "PWR", "NWF", "SRV",
    "MAIN", "MCH", "LAVA", "MINE"
}

local lastStateTimestamp = -1
local lastRedstone = false
local lastMainDoor = false
local lastPortalDoor = false
local lastAllyRelay = false
local lastFloorActive = {}
local lastSpeakerAt = -math.huge

local function requestStop()
    local file = fs.open("radar_stop", "w")
    if file then
        file.write("stop")
        file.close()
    end
    error("Terminated")
end

local function readState()
    if not fs.exists(STATE_FILE) then return nil end

    local file = fs.open(STATE_FILE, "r")
    if not file then return nil end

    local data = textutils.unserialiseJSON(file.readAll())
    file.close()

    return type(data) == "table" and data or nil
end

local function setOutputIfChanged(relay, side, value)
    if relay then
        relay.setOutput(side, value)
    end
end

local function updateRelay(relay, side, value, lastValue)
    if value ~= lastValue then
        setOutputIfChanged(relay, side, value)
        return value
    end
    return lastValue
end

local function applyState(state)
    local flags = state.flags or {}
    local players = state.players or {}
    local activeFloors = {}

    for _, player in ipairs(players) do
        if player.floor and FLOOR_RELAYS[player.floor] then
            activeFloors[player.floor] = true
        end
    end

    -- Floor outputs are changed only when their state changes.
    for _, floor in ipairs(FLOOR_ORDER) do
        local enabled = activeFloors[floor] == true
        local previous = lastFloorActive[floor] == true

        if enabled ~= previous then
            local relay = FLOOR_RELAYS[floor]
            if relay then
                relay.setOutput("top", enabled)
            end
            lastFloorActive[floor] = enabled
        end
    end

    -- Existing TOP/front ally relay behaviour.
    lastAllyRelay = updateRelay(
        FLOOR_RELAYS.TOP,
        "front",
        flags.allyRelayMatched == true,
        lastAllyRelay
    )

    -- Main security redstone output.
    local redstoneValue = flags.redstoneMatched == true
    if redstoneValue ~= lastRedstone then
        redstone.setOutput(REDSTONE_SIDE, redstoneValue)
        lastRedstone = redstoneValue
    end

    -- Main entrance: team opens it, enemy lockdown overrides it.
    local mainDoor = flags.mainDoorOpen == true
        and flags.lockdownMainDoor ~= true

    lastMainDoor = updateRelay(
        DOOR_MAIN_OPENER_RELAY,
        "top",
        mainDoor,
        lastMainDoor
    )

    -- Portal entrance.
    lastPortalDoor = updateRelay(
        DOOR_PORTAL_OPENER_RELAY,
        "top",
        flags.portalDoorOpen == true,
        lastPortalDoor
    )

    -- Alarm.
    if flags.speakerMatched == true
        and os.clock() - lastSpeakerAt >= SPEAKER_COOLDOWN then

        for _, speaker in ipairs(speakers) do
            speaker.playSound("powergrid:alarm_bell")
        end

        lastSpeakerAt = os.clock()
    end
end

local function cleanup()
    redstone.setOutput(REDSTONE_SIDE, false)

    for _, relay in pairs(FLOOR_RELAYS) do
        if relay then
            relay.setOutput("top", false)
            relay.setOutput("front", false)
        end
    end

    if DOOR_MAIN_OPENER_RELAY then
        DOOR_MAIN_OPENER_RELAY.setOutput("top", false)
    end

    if DOOR_PORTAL_OPENER_RELAY then
        DOOR_PORTAL_OPENER_RELAY.setOutput("top", false)
    end
end

cleanup()

print("REDSTONE: " .. #speakers .. " speaker(s)")
print("REDSTONE: update interval = " .. REDSTONE_INTERVAL .. "s")

local ok, err = pcall(function()
    while not fs.exists("radar_stop") do
        local state = readState()

        if state and state.timestamp ~= lastStateTimestamp then
            local loopStart = os.clock()

            lastStateTimestamp = state.timestamp
            applyState(state)

            local loopTimeMs = (os.clock() - loopStart) * 1000
            maxLoopTimeMs = math.max(maxLoopTimeMs, loopTimeMs)
            loopSamples = loopSamples + 1
            avgLoopTimeMs =
                avgLoopTimeMs + (loopTimeMs - avgLoopTimeMs) / loopSamples

            if DEBUG_TIMING then
                term.setTextColor(colors.lightGray)
                print(string.format(
                    "Loop: %.3f ms | avg: %.3f ms | max: %.3f ms",
                    loopTimeMs,
                    avgLoopTimeMs,
                    maxLoopTimeMs
                ))
                term.setTextColor(colors.white)
            end
        end

        local timer = os.startTimer(REDSTONE_INTERVAL)

        while true do
            local event, p1 = os.pullEvent()

            if event == "key" and p1 == keys.c then
                requestStop()
            elseif event == "timer" and p1 == timer then
                break
            end

            if fs.exists("radar_stop") then
                return
            end
        end
    end
end)

cleanup()

if not ok and err ~= "Terminated" then
    printError(err)
end
