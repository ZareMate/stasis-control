-- =========================================================
-- RADAR CLIENT
-- Reads local create_radar monitors and broadcasts player
-- snapshots to the radar server over Rednet.
-- =========================================================

-- Change this to the side or peripheral name of the wireless modem.
local REDNET_SIDE = "bottom"
local SERVER_ID = 17
local PROTOCOL = "radar"
local CATEGORY_FILTER = "PLAYER"
local SEND_INTERVAL = 1

local radarMonitors = { peripheral.find("create_radar:monitor") }
if #radarMonitors == 0 then
    error("No create_radar:monitor peripherals found")
end

local modem = peripheral.wrap(REDNET_SIDE)
if not modem or not modem.isWireless or not modem.isWireless() then
    error("No wireless modem found on " .. REDNET_SIDE)
end
if not rednet.isOpen(REDNET_SIDE) then
    rednet.open(REDNET_SIDE)
end

if not http then
    error("HTTP API is not enabled; it is needed to resolve player UUIDs")
end

local usernameHelper = dofile("username_helper.lua")

local function usernameFromUUID(uuid)
    return usernameHelper.usernameFromUUID(uuid)
end

local function collectPlayers()
    local players = {}
    local seen = {}

    for _, radar in ipairs(radarMonitors) do
        for _, track in ipairs(radar.getTracks() or {}) do
            if track.category == CATEGORY_FILTER then
                local position = track.position or {}
                local x = tonumber(position.x)
                local y = tonumber(position.y)
                local z = tonumber(position.z)
                local uuid = track.id

                if x and y and z and uuid and not seen[uuid] then
                    seen[uuid] = true
                    local username = usernameFromUUID(uuid)
                    if username then
                        players[#players + 1] = {
                            username = username,
                            x = ("%.2f"):format(x),
                            y = ("%.2f"):format(y),
                            z = ("%.2f"):format(z)
                        }
                    end
                end
            end
        end
    end

    return players
end

print("Radar client ready")
print("Computer ID: " .. os.getComputerID())
print("Sending to server computer " .. SERVER_ID)
print("Press Ctrl+T to stop")

while true do
    local players = collectPlayers()
    local packet = {
        data = players,
        timestamp = os.epoch("utc")
    }
    local sent = rednet.send(SERVER_ID, packet, PROTOCOL)
    print(sent
        and ("Sent " .. #players .. " player(s) to server " .. SERVER_ID)
        or ("Send failed; check modem connection to server " .. SERVER_ID))
    sleep(SEND_INTERVAL)
end
