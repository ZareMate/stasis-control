-- =========================================================
-- RADAR AREA HELPER
-- Shared cuboid/zone detection for the radar system.
-- =========================================================

local M = {}

local SQUARE_CENTER_X = -111
local SQUARE_CENTER_Z = 243
local SQUARE_HALF_SIZE = 100

local FLOOR_HALF_SIZE = 50

M.AREAS = {
    PLAYER_SQUARE = {
        SQUARE_CENTER_X - SQUARE_HALF_SIZE,
        0,
        SQUARE_CENTER_Z - SQUARE_HALF_SIZE,
        SQUARE_CENTER_X + SQUARE_HALF_SIZE,
        0,
        SQUARE_CENTER_Z + SQUARE_HALF_SIZE
    },

    FLOOR_SQUARE = {
        SQUARE_CENTER_X - FLOOR_HALF_SIZE,
        0,
        SQUARE_CENTER_Z - FLOOR_HALF_SIZE,
        SQUARE_CENTER_X + FLOOR_HALF_SIZE,
        0,
        SQUARE_CENTER_Z + FLOOR_HALF_SIZE
    },

    REDSTONE_DETECTION = {
        -99, 70, 250,
        -96, 72, 247
    },

    ALLY_RELAY = {
        -103, 78, 253,
        -97, 71, 250
    },

    MAIN_DOOR_OPEN = {
        -98, 70, 245,
        -97, 72, 248
    },

    PORTAL_DOOR_OPEN = {
        -96, 69, 239,
        -94, 71, 238
    }
}

M.ALLY_RELAY_AREAS = {
    M.AREAS.REDSTONE_DETECTION,
    M.AREAS.ALLY_RELAY
}

function M.isInsideArea(area, x, y, z)
    if type(area) ~= "table" then
        return false
    end

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

function M.isInsideNamedArea(name, x, y, z)
    return M.isInsideArea(M.AREAS[name], x, y, z)
end

function M.isInsidePlayerSquare(x, z)
    return x >= SQUARE_CENTER_X - SQUARE_HALF_SIZE
        and x <= SQUARE_CENTER_X + SQUARE_HALF_SIZE
        and z >= SQUARE_CENTER_Z - SQUARE_HALF_SIZE
        and z <= SQUARE_CENTER_Z + SQUARE_HALF_SIZE
end

function M.isInsideFloorSquare(x, z)
    return x >= SQUARE_CENTER_X - FLOOR_HALF_SIZE
        and x <= SQUARE_CENTER_X + FLOOR_HALF_SIZE
        and z >= SQUARE_CENTER_Z - FLOOR_HALF_SIZE
        and z <= SQUARE_CENTER_Z + FLOOR_HALF_SIZE
end

function M.isInsideAnyAllyRelayArea(x, y, z)
    for _, area in ipairs(M.ALLY_RELAY_AREAS) do
        if M.isInsideArea(area, x, y, z) then
            return true
        end
    end

    return false
end

return M
