-- =========================================================
-- RADAR FLOOR HELPER
-- Converts a player's Y coordinate into the radar facility floor.
-- =========================================================

local M = {}

local FLOORS = {
    { name = "TOP",  min = 68,  max = 71 },
    { name = "PWR",  min = 56,  max = 64 },
    { name = "NWF",  min = 38,  max = 46 },
    { name = "SRV",  min = 29,  max = 33 },
    { name = "MAIN", min = 22,  max = 27 },
    { name = "MCH",  min = 12,  max = 18 },
    { name = "LAVA", min = -11, max = -7 }
}

function M.getPlayerFloor(y)
    if type(y) ~= "number" then
        return nil
    end

    for _, floor in ipairs(FLOORS) do
        if y >= floor.min and y <= floor.max then
            return floor.name
        end
    end

    if y < -20 then
        return "MINE"
    end

    return nil
end

function M.getFloors()
    return FLOORS
end

return M
