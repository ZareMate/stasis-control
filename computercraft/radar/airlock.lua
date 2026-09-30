-- =========================================================
-- RADAR AIRLOCK CONTROLLER
-- =========================================================
-- Detects TEAM players inside two X/Z airlock areas on each
-- radar facility floor and drives two relay outputs per floor.
--
-- Area 1 -> relay "left"
-- Area 2 -> relay "right"
--
-- Relay peripherals use the same floor relay mapping as
-- radar/redstone.lua.
-- =========================================================

local STATE_FILE = "radar_state.json"
local INTERVAL = 0.05

local areaHelper = dofile("area_helper.lua")
local floorHelper = dofile("floor_helper.lua")

-- =========================================================
-- CONFIGURATION
-- =========================================================

local AIRLOCK_AREAS = {
    {
        name = "AREA_1",
        x1 = -87,
        z1 = 244,
        x2 = -93,
        z2 = 242
    },
    {
        name = "AREA_2",
        x1 = -98,
        z1 = 244,
        x2 = -93,
        z2 = 242
    }
}

-- Uses the existing radar floor relays.
-- Change the peripheral name if an airlock has its own relay.
--
-- left  = AIRLOCK_AREAS[1]
-- right = AIRLOCK_AREAS[2]
local FLOOR_RELAYS = {
    TOP = "redstone_relay_52",
    PWR = "redstone_relay_42",
    NWF = "redstone_relay_43",
    SRV = "redstone_relay_44",
    MAIN = "redstone_relay_45",
    MCH = "redstone_relay_46",
    LAVA = "redstone_relay_47",
    MINE = "redstone_relay_48"
}

local AREA_OUTPUT_SIDES = {
    [1] = "left",
    [2] = "right"
}

local FLOOR_ORDER = {
    "TOP",
    "PWR",
    "NWF",
    "SRV",
    "MAIN",
    "MCH",
    "LAVA",
    "MINE"
}

-- =========================================================
-- RELAY SETUP
-- =========================================================

local relays = {}

for _, floor in ipairs(FLOOR_ORDER) do
    local peripheralName = FLOOR_RELAYS[floor]

    if peripheralName then
        relays[floor] = peripheral.wrap(peripheralName)

        if not relays[floor] then
            printError(
                "AIRLOCK: missing relay " ..
                peripheralName ..
                " for " ..
                floor
            )
        end
    end
end

-- =========================================================
-- AREA DETECTION
-- =========================================================

local function isInsideXZ(area, x, z)
    local minX = math.min(area.x1, area.x2)
    local maxX = math.max(area.x1, area.x2)
    local minZ = math.min(area.z1, area.z2)
    local maxZ = math.max(area.z1, area.z2)

    return x >= minX
        and x <= maxX
        and z >= minZ
        and z <= maxZ
end

local function getActiveAreas(state)
    local active = {}

    for _, floor in ipairs(FLOOR_ORDER) do
        active[floor] = {
            [1] = false,
            [2] = false
        }
    end

    for _, player in ipairs(state.players or {}) do
        if player.status == "team" then
            local x = tonumber(player.x)
            local y = tonumber(player.y)
            local z = tonumber(player.z)

            if x and y and z then
                local floor = floorHelper.getPlayerFloor(y)

                if floor and active[floor] then
                    for areaIndex, area in ipairs(AIRLOCK_AREAS) do
                        if isInsideXZ(area, x, z) then
                            active[floor][areaIndex] = true
                        end
                    end
                end
            end
        end
    end

    return active
end

-- =========================================================
-- OUTPUT
-- =========================================================

local lastActive = {}

local function setRelayOutput(relay, side, value)
    if relay then
        relay.setOutput(side, value)
    end
end

local function applyState(active)
    for _, floor in ipairs(FLOOR_ORDER) do
        local relay = relays[floor]
        local floorActive = active[floor] or {}

        lastActive[floor] = lastActive[floor] or {
            [1] = false,
            [2] = false
        }

        for areaIndex = 1, #AIRLOCK_AREAS do
            local value = floorActive[areaIndex] == true

            if value ~= lastActive[floor][areaIndex] then
                setRelayOutput(
                    relay,
                    AREA_OUTPUT_SIDES[areaIndex],
                    value
                )

                lastActive[floor][areaIndex] = value
            end
        end
    end
end

local function cleanup()
    for _, floor in ipairs(FLOOR_ORDER) do
        local relay = relays[floor]

        if relay then
            for areaIndex = 1, #AIRLOCK_AREAS do
                setRelayOutput(
                    relay,
                    AREA_OUTPUT_SIDES[areaIndex],
                    false
                )
            end
        end
    end
end

-- =========================================================
-- STATE READING
-- =========================================================

local function readState()
    if not fs.exists(STATE_FILE) then
        return nil
    end

    local file = fs.open(STATE_FILE, "r")

    if not file then
        return nil
    end

    local ok, data =
        pcall(
            textutils.unserialiseJSON,
            file.readAll()
        )

    file.close()

    if ok and type(data) == "table" then
        return data
    end

    return nil
end

-- =========================================================
-- DISPLAY
-- =========================================================

local function display(active)
    term.clear()
    term.setCursorPos(1, 1)
    term.setTextColor(colors.white)

    print("---- RADAR AIRLOCK ----")
    print("TEAM member area detection")
    print("")

    for _, floor in ipairs(FLOOR_ORDER) do
        local areas = active[floor] or {}
        local area1 = areas[1] == true
        local area2 = areas[2] == true

        term.setTextColor(
            area1 and colors.lime or colors.gray
        )
        print(
            floor ..
            " A1: " ..
            (area1 and "ON " or "OFF")
        )

        term.setTextColor(
            area2 and colors.lime or colors.gray
        )
        print(
            "    A2: " ..
            (area2 and "ON" or "OFF")
        )
    end

    term.setTextColor(colors.white)
end

-- =========================================================
-- MAIN
-- =========================================================

cleanup()

print("AIRLOCK: controller ready")
print("AIRLOCK: Area 1 = X -87..-93, Z 244..242")
print("AIRLOCK: Area 2 = X -98..-93, Z 244..242")
print("AIRLOCK: TEAM players only")
print("")

local lastTimestamp = nil

while not fs.exists("radar_stop") do
    local state = readState()

    if state and state.timestamp ~= lastTimestamp then
        lastTimestamp = state.timestamp

        local active =
            getActiveAreas(state)

        applyState(active)
        display(active)
    end

    local timer = os.startTimer(INTERVAL)

    while true do
        local event, id = os.pullEvent()

        if event == "timer" and id == timer then
            break
        elseif event == "key" and id == keys.c then
            cleanup()
            error("Terminated")
        end

        if fs.exists("radar_stop") then
            break
        end
    end
end

cleanup()
