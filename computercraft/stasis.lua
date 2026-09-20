-- Stasis Control ComputerCraft controller
-- One controller should run for each base.
--
-- The server tracks chambers by BASE + CHAMBER.
-- The website never sends raw redstone commands.

local SERVER = "ws://YOUR_SERVER_IP:3000/ws"
local TOKEN = "YOUR_STASIS_TOKEN"
local CONTROLLER_NAME = "base-1"
local BASE_ID = 1

local PULSE_TIME = 0.20

-- Add the chamber number when you know it.
-- "chamber" is used for the initial ready announcement.
-- The player name is still used to find the relay when a pull arrives.
local RELAYS = {
    { chamber = 1, player = "Piotrusek69", relay = "redstone_relay_1" },
    { chamber = 2, player = "Toprak", relay = "redstone_relay_2" },
    { chamber = 3, player = "Bobschneleton", relay = "redstone_relay_3" },
    -- { chamber = 4, player = "AnotherPlayer", relay = "redstone_relay_4" },
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
        print("WebSocket send failed: " .. tostring(err))
        return false
    end

    return true
end

local function sendStatus(ws, chamber, player, status)
    return sendMessage(ws, {
        type = "status",
        chamber = chamber,
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

    -- Protect this controller from accidentally handling another base's command.
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

    sendStatus(ws, chamber, player, "pulling")

    local success, pulseError = pulseRelay(entry.relay)

    if success then
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

            -- Tell the website that this chamber is currently ready.
            sendStatus(
                ws,
                entry.chamber,
                entry.player,
                "ready"
            )
        else
            print(
                "Missing relay: " ..
                entry.relay ..
                " for " ..
                entry.player
            )

            -- Report the chamber as unavailable instead of leaving
            -- the website showing stale READY data.
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

while true do
    term.clear()
    term.setCursorPos(1, 1)

    print("================================")
    print("          STASIS CONTROL")
    print("================================")
    print("Controller: " .. CONTROLLER_NAME)
    print("Base:       " .. tostring(BASE_ID))
    print("Server:     " .. SERVER)
    print("")

    local ws, err = connect()

    if not ws then
        print("Connection failed: " .. tostring(err))
        print("Retrying in 5 seconds...")
        sleep(5)
    else
        print("Connected to Stasis Control")
        print("")

        announceConfiguredPlayers(ws)

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
                    end
                end

            elseif event == "websocket_closed" then
                print("Connection closed")
                break
            end
        end

        pcall(function()
            ws.close()
        end)

        print("Reconnecting in 2 seconds...")
        sleep(2)
    end
end
