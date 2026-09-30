-- =========================================================
-- RADAR REDNET TEST
-- =========================================================
-- Usage:
--   radar_test send
--   radar_test receive
--
-- Uses the same modem side and radar_raw protocol as radar.lua
-- but the test packet intentionally does NOT contain a players
-- table, so the real radar receiver will ignore it.
-- =========================================================

local REDNET_SIDE = "bottom"
local PROTOCOL = "radar_raw"

local modem = peripheral.wrap(REDNET_SIDE)

if not modem then
    error("No modem found on side: " .. REDNET_SIDE)
end

if not modem.isWireless or not modem.isWireless() then
    error("Modem on " .. REDNET_SIDE .. " is not wireless")
end

if not rednet.isOpen(REDNET_SIDE) then
    rednet.open(REDNET_SIDE)
end

local mode = (arg and arg[1]) or "receive"

print("================================")
print("       RADAR REDNET TEST        ")
print("================================")
print("Computer ID: " .. os.getComputerID())
print("Protocol:    " .. PROTOCOL)
print("Modem:       " .. REDNET_SIDE)
print("Mode:        " .. mode)
print("")

------------------------------------------------------------
-- RECEIVE
------------------------------------------------------------

local function receiveMode()
    rednet.host(PROTOCOL, "radar-test-" .. os.getComputerID())

    print("Hosting " .. PROTOCOL)
    print("Waiting for test packets...")
    print("")

    while true do
        local sender, message, protocol = rednet.receive()

        if protocol == PROTOCOL then
            print("--------------------------------")
            print("RECEIVED PACKET")
            print("Sender ID: " .. tostring(sender))
            print("Protocol:  " .. tostring(protocol))

            print("Message type: " .. type(message))

            if type(message) == "table" then
                print("Source:     " .. tostring(message.source))
                print("Timestamp:  " .. tostring(message.timestamp))
                print("Test:       " .. tostring(message.test))
                print("Text:       " .. tostring(message.text))

                if type(message.sampleTrack) == "table" then
                    print("")
                    print("Sample raw track:")
                    print("  id:         " .. tostring(message.sampleTrack.id))
                    print("  category:   " .. tostring(message.sampleTrack.category))
                    print("  entityType: " .. tostring(message.sampleTrack.entityType))

                    local pos = message.sampleTrack.position or {}

                    print("  position:")
                    print("    x = " .. tostring(pos.x))
                    print("    y = " .. tostring(pos.y))
                    print("    z = " .. tostring(pos.z))
                end

                print("")
                print("Raw packet:")
                print(textutils.serialiseJSON(message))
            else
                print("Message:")
                print(tostring(message))
            end

            print("--------------------------------")
            print("")
        end
    end
end

------------------------------------------------------------
-- SEND
------------------------------------------------------------

local function sendMode()
    print("Looking for radar_raw hosts...")
    print("")

    local computers = { rednet.lookup(PROTOCOL) }

    if #computers == 0 then
        print("No hosts found!")
        print("")
        print("Make sure the other computer is running:")
        print("  radar_test receive")
        return
    end

    print("Found " .. #computers .. " host(s):")

    for _, computer in ipairs(computers) do
        print("  ID " .. tostring(computer))
    end

    print("")

    local payload = {
        source = os.getComputerID(),
        timestamp = os.epoch("utc"),
        test = true,
        text = "RADAR REDNET TEST PACKET",

        -- This deliberately is NOT called "players".
        -- Your real radar.lua will therefore ignore this packet.
        sampleTrack = {
            id = "TEST-UUID-1234",
            category = "PLAYER",
            entityType = "minecraft:player",
            position = {
                x = -111.5,
                y = 70.0,
                z = 243.5
            }
        }
    }

    for _, computer in ipairs(computers) do
        if computer ~= os.getComputerID() then
            print(
                "Sending to computer " ..
                tostring(computer) ..
                "..."
            )

            local ok = rednet.send(
                computer,
                payload,
                PROTOCOL
            )

            if ok then
                print("  SEND OK")
            else
                print("  SEND FAILED")
            end
        end
    end

    print("")
    print("Packet sent.")
    print("")
    print("Press Ctrl+T to stop.")
end

------------------------------------------------------------
-- MAIN
------------------------------------------------------------

if mode == "send" then
    sendMode()
elseif mode == "receive" or mode == "recv" then
    receiveMode()
else
    print("Usage:")
    print("  radar_test send")
    print("  radar_test receive")
end