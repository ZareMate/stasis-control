-- Stasis Control - pulling / relay process
-- Receives pull commands from the boot process and operates relays.
-- This runs independently from the Radar process.

local PULSE_TIME = 1

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

local function findRelay(player)
    for _, entry in ipairs(RELAYS) do
        if string.lower(entry.player) == string.lower(player) then
            return entry
        end
    end

    return nil
end

local function getRelay(name)
    if not peripheral.isPresent(name) then
        return nil, "Peripheral not found: " .. name
    end

    if peripheral.getType(name) ~= "redstone_relay" then
        return nil,
            "Peripheral " .. name ..
            " is not a redstone_relay"
    end

    return peripheral.wrap(name)
end

local function queueStatus(chamber, player, status, label)
    os.queueEvent(
        "stasis_status",
        {
            source = "pulling",
            chamber = chamber,
            player = player or "",
            status = status,
            label = label or
                ("Chamber " ..
                 string.format("%02d", chamber))
        }
    )
end

local function queuePullResult(
    chamber,
    player,
    requestId,
    success,
    errorMessage
)
    os.queueEvent(
        "stasis_pull_result",
        {
            chamber = chamber,
            player = player or "",
            requestId = requestId or "",
            success = success == true,
            error = errorMessage
        }
    )
end

local function pulseRelay(relayName)
    local relay, err = getRelay(relayName)

    if not relay then
        return false, err
    end

    local ok, pulseError = pcall(function()
        relay.setOutput("front", true)
        sleep(PULSE_TIME)
        relay.setOutput("front", false)
    end)

    if not ok then
        return false, tostring(pulseError)
    end

    return true
end

local function handlePull(command)
    local chamber = tonumber(command.chamber)
    local player = tostring(command.player or "")
    local requestId = tostring(command.requestId or "")

    if not chamber or player == "" then
        queuePullResult(
            chamber,
            player,
            requestId,
            false,
            "Pull command is missing chamber or player"
        )
        return
    end

    local configured = findRelay(player)

    if not configured then
        print(
            "[PULLING] No relay for " ..
            player ..
            " in chamber " ..
            tostring(chamber)
        )

        queueStatus(chamber, player, "ready")
        queuePullResult(
            chamber,
            player,
            requestId,
            false,
            "No relay configured for player " .. player
        )
        return
    end

    if tonumber(configured.chamber) ~= chamber then
        print(
            "[PULLING] WARNING: server chamber " ..
            tostring(chamber) ..
            " != configured chamber " ..
            tostring(configured.chamber)
        )
    end

    print("")
    print("[PULLING] Pull request")
    print("  Player:  " .. player)
    print("  Chamber: " .. tostring(chamber))
    print("  Relay:   " .. configured.relay)

    queueStatus(chamber, player, "pulling")

    local success, pulseError = pulseRelay(
        configured.relay
    )

    if success then
        queueStatus(chamber, player, "pulled")

        queuePullResult(
            chamber,
            player,
            requestId,
            true
        )

        print("  Result:  pulled")
    else
        queueStatus(chamber, player, "ready")

        queuePullResult(
            chamber,
            player,
            requestId,
            false,
            pulseError
        )

        print("  Result:  relay failed")
    end
end

print("==============================")
print("      STASIS CONTROL")
print("         PULLING")
print("==============================")

for _, entry in ipairs(RELAYS) do
    local relay, err = getRelay(entry.relay)

    if relay then
        print(
            "[PULLING] Ready: " ..
            entry.player ..
            " -> " ..
            entry.relay
        )
    else
        print(
            "[PULLING] Missing: " ..
            entry.player ..
            " -> " ..
            entry.relay ..
            " (" .. tostring(err) .. ")"
        )
    end
end

while true do
    local event, a = os.pullEvent()

    if event == "stasis_pull" then
        if a then
            handlePull(a)
        end

    elseif event == "stasis_shutdown" then
        return

    elseif event == "terminate" then
        os.queueEvent("stasis_shutdown")
        return
    end
end
