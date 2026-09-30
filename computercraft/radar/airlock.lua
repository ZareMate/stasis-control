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

-- Each floor has two dedicated relays:
--   first  = AREA_1
--   second = AREA_2
--
-- Both relays use their FRONT output.
local FLOOR_RELAYS = {
    TOP = {
        [1] = "redstone_relay_85",
        [2] = "redstone_relay_86"
    },
    PWR = {
        [1] = "redstone_relay_69",
        [2] = "redstone_relay_70"
    },
    NWF = {
        [1] = "redstone_relay_77",
        [2] = "redstone_relay_78"
    },
    SRV = {
        [1] = "redstone_relay_75",
        [2] = "redstone_relay_76"
    },
    MAIN = {
        [1] = "redstone_relay_73",
        [2] = "redstone_relay_74"
    },
    MCH = {
        [1] = "redstone_relay_71",
        [2] = "redstone_relay_72"
    },
    LAVA = {
        [1] = "redstone_relay_59",
        [2] = "redstone_relay_60"
    }
}

local AIRLOCK_OUTPUT_SIDE = "front"

local FLOOR_ORDER = {
    "TOP",
    "PWR",
    "NWF",
    "SRV",
    "MAIN",
    "MCH",
    "LAVA"
}

-- =========================================================
-- RELAY SETUP
-- =========================================================

local relays = {}

for _, floor in ipairs(FLOOR_ORDER) do
    relays[floor] = {
        [1] = peripheral.wrap(FLOOR_RELAYS[floor][1]),
        [2] = peripheral.wrap(FLOOR_RELAYS[floor][2])
    }

    for areaIndex = 1, 2 do
        if not relays[floor][areaIndex] then
            printError(
                "AIRLOCK: missing relay " ..
                FLOOR_RELAYS[floor][areaIndex] ..
                " for " ..
                floor ..
                " area " ..
                areaIndex
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
                    relay[areaIndex],
                    AIRLOCK_OUTPUT_SIDE,
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
                    relay[areaIndex],
                    AIRLOCK_OUTPUT_SIDE,
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
