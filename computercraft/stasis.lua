-- Stasis Control ComputerCraft controller
-- The RELAYS list is the only section you need to edit for chamber hardware.

local SERVER = "ws://YOUR_SERVER_IP:3000/ws"
local TOKEN = "YOUR_STASIS_TOKEN"
local CONTROLLER_NAME = "base-1"

-- How long the pulse lasts.
local PULSE_TIME = 0.20

-- Map Minecraft players to ComputerCraft redstone relays.
-- relay = the wired peripheral name shown by "peripherals".
local RELAYS = {
    { player = "Piotrusek69", relay = "redstone_relay_1" },
    { player = "Toprak",      relay = "redstone_relay_2" },
    { player = "Bobschneleton", relay = "redstone_relay_3" },
    -- { player = "AnotherPlayer", relay = "redstone_relay_4" },
}

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
        return nil, "Peripheral " .. name .. " is " ..
            tostring(peripheralType) .. ", not redstone_relay"
    end

    return peripheral.wrap(name)
end

local function sendStatus(ws, chamber, player, value)
    local ok, err = pcall(function()
        ws.send(textutils.serializeJSON({
            type = "status",
            chamber = chamber,
            player = player or "",
            status = value
        }))
    end)

    if not ok then
        print("Status send failed: " .. tostring(err))
    end
end

local function pulseRelay(relayName)
    local relay, err = getRelayPeripheral(relayName)

    if not relay then
        print(err)
        return false, err
    end

    local ok, pulseError = pcall(function()
        relay.setOutput("front", true)
        relay.setOutput("top", true)

        sleep(PULSE_TIME)

        relay.setOutput("front", false)
        relay.setOutput("top", false)
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

    if not chamber then
        print("Ignoring pull with invalid chamber")
        return
    end

    if player == "" then
        print("Ignoring pull with no player")
        return
    end

    local entry = findRelay(player)

    if not entry then
        print("Ignoring chamber " .. chamber ..
            ": no relay configured for player " .. player)
        return
    end

    print("")
    print("Pull request")
    print("  Player:  " .. player)
    print("  Chamber: " .. chamber)
    print("  Relay:   " .. entry.relay)

    sendStatus(ws, chamber, player, "pulling")

    local success = pulseRelay(entry.relay)

    if success then
        sendStatus(ws, chamber, player, "pulled")
        print("  Result:  pulled")
    else
        sendStatus(ws, chamber, player, "ready")
        print("  Result:  relay failed")
    end
end

local function announceConfiguredPlayers(ws)
    for _, entry in ipairs(RELAYS) do
        local relay = getRelayPeripheral(entry.relay)

        if relay then
            print("Configured: " .. entry.player .. " -> " .. entry.relay)
        else
            print("Missing relay: " .. entry.relay ..
                " for " .. entry.player)
        end
    end
end

print("================================")
print("       STASIS CONTROL           ")
print("================================")
print("Controller: " .. CONTROLLER_NAME)
print("Server:     " .. SERVER)
print("")

while true do
    local ws, err = http.websocket(
        SERVER ..
        "?role=controller&name=" .. encode(CONTROLLER_NAME) ..
        "&token=" .. encode(TOKEN)
    )

    if not ws then
        print("Connection failed: " .. tostring(err))
        print("Retrying in 5 seconds...")
        sleep(5)
    else
        print("Connected to Stasis Control")
        announceConfiguredPlayers(ws)

        while true do
            local event, a, b = os.pullEvent()

            if event == "websocket_message" then
                local ok, message = pcall(
                    textutils.unserializeJSON,
                    b
                )

                if ok and message and message.type == "pull" then
                    handlePull(ws, message)
                end
            elseif event == "websocket_closed" then
                print("Connection closed")
                break
            end
        end

        pcall(function()
            ws.close()
        end)

        print("Reconnecting...")
        sleep(2)
    end
end
