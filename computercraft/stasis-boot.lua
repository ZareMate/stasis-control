-- Stasis Control - boot / WebSocket process
-- Owns the server WebSocket and routes events between the Radar
-- and Pulling processes.

local SERVER = "wss://stasis.suchodupin.com/ws"
local TOKEN = "YOUR_STASIS_TOKEN"
local CONTROLLER_NAME = "base-1"
local BASE_ID = 1

local HEARTBEAT_INTERVAL = 10
local HEARTBEAT_TIMEOUT = 5
local RECONNECT_DELAY = 2

local heartbeatPending = false
local heartbeatSentAt = 0
local heartbeatId = 0
local lastError = nil
local pendingStatus = {}
local pendingPullResults = {}

local function encode(value)
    return textutils.urlEncode(tostring(value))
end

local function queueStatus(message)
    if not message or message.chamber == nil then
        return
    end

    pendingStatus[tostring(message.chamber)] = message
end

local function queuePullResult(message)
    if message then
        table.insert(pendingPullResults, message)
    end
end

local function sendMessage(ws, message)
    local ok, err = pcall(function()
        ws.send(textutils.serializeJSON(message))
    end)

    if not ok then
        lastError = tostring(err)
        print("[BOOT] WebSocket send failed: " .. lastError)
        return false
    end

    return true
end

local function flushPending(ws)
    for key, message in pairs(pendingStatus) do
        if sendMessage(ws, message) then
            pendingStatus[key] = nil
        end
    end

    while #pendingPullResults > 0 do
        local message = table.remove(pendingPullResults, 1)

        if not sendMessage(ws, message) then
            table.insert(pendingPullResults, 1, message)
            break
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

    print("[BOOT] Connecting to " .. SERVER)

    return http.websocket(url)
end

local function closeSocket(ws)
    if ws then
        pcall(function()
            ws.close()
        end)
    end
end

local function sendHeartbeat(ws)
    heartbeatId = heartbeatId + 1
    heartbeatSentAt = os.epoch("utc")
    heartbeatPending = true

    return sendMessage(ws, {
        type = "heartbeat",
        id = heartbeatId
    })
end

local function handleServerMessage(message)
    if message.type == "pull" then
        os.queueEvent("stasis_pull", message)
        return
    end

    if message.type == "heartbeat-ack" then
        if message.id == heartbeatId or message.id == nil then
            heartbeatPending = false
            lastError = nil
        end
    end
end

local function runConnection(ws)
    heartbeatPending = false
    heartbeatSentAt = 0
    lastError = nil

    os.queueEvent("stasis_ws_connected")
    os.queueEvent("stasis_request_sync")

    flushPending(ws)
    sendHeartbeat(ws)

    local heartbeatTimer = os.startTimer(HEARTBEAT_INTERVAL)
    local heartbeatCheckTimer = os.startTimer(1)

    print("[BOOT] Connected")

    while true do
        local event, a, b = os.pullEvent()

        if event == "websocket_message" then
            local ok, message = pcall(
                textutils.unserializeJSON,
                b
            )

            if ok and message then
                handleServerMessage(message)
            else
                print("[BOOT] Invalid server message")
            end

        elseif event == "websocket_closed" then
            print("[BOOT] WebSocket closed")
            break

        elseif event == "stasis_status" then
            local message = a

            if message then
                queueStatus({
                    type = "status",
                    base = BASE_ID,
                    baseName = "Base " .. tostring(BASE_ID),
                    chamber = message.chamber,
                    label = message.label or
                        ("Chamber " .. string.format("%02d", message.chamber)),
                    player = message.player or "",
                    status = message.status
                })

                flushPending(ws)
            end

        elseif event == "stasis_pull_result" then
            local message = a

            if message then
                queuePullResult({
                    type = "pull-result",
                    chamber = message.chamber,
                    player = message.player or "",
                    requestId = message.requestId or "",
                    success = message.success == true,
                    error = message.error
                })

                flushPending(ws)
            end

        elseif event == "timer" then
            if a == heartbeatTimer then
                heartbeatTimer = os.startTimer(HEARTBEAT_INTERVAL)

                if heartbeatPending then
                    lastError = "Heartbeat timeout"
                    print("[BOOT] Heartbeat timeout")
                    break
                end

                if not sendHeartbeat(ws) then
                    break
                end

            elseif a == heartbeatCheckTimer then
                heartbeatCheckTimer = os.startTimer(1)

                if heartbeatPending and
                   os.epoch("utc") - heartbeatSentAt >
                   (HEARTBEAT_TIMEOUT * 1000) then
                    lastError = "Heartbeat timeout"
                    print("[BOOT] Heartbeat timeout")
                    break
                end
            end

        elseif event == "terminate" then
            closeSocket(ws)
            os.queueEvent("stasis_shutdown")
            return false
        end
    end

    closeSocket(ws)
    os.queueEvent("stasis_ws_disconnected")
    return true
end

while true do
    term.clear()
    term.setCursorPos(1, 1)

    print("==============================")
    print("      STASIS CONTROL")
    print("          BOOT")
    print("==============================")
    print("Controller: " .. CONTROLLER_NAME)
    print("Base:       " .. tostring(BASE_ID))
    print("Server:     " .. SERVER)
    print("")

    local ws, err = connect()

    if ws then
        local reconnect = runConnection(ws)

        if not reconnect then
            break
        end
    else
        print("[BOOT] Connection failed: " .. tostring(err))
        os.queueEvent("stasis_ws_disconnected")
    end

    print("[BOOT] Reconnecting in " .. tostring(RECONNECT_DELAY) .. " seconds...")
    sleep(RECONNECT_DELAY)
end

os.queueEvent("stasis_shutdown")
