-- =========================================================
-- RADAR SCANNER / SENDER
-- =========================================================
local radarMonitors = { peripheral.find("create_radar:monitor") }
local speakers = { peripheral.find("speaker") }


-- =========================================================
-- Dedicated player-list monitor.
-- This monitor is NOT included in the normal monitor list.
--
-- Change this to the peripheral name of your LEFT monitor.
-- Use the startup peripheral listing to find the name.
-- =========================================================
local PLAYER_LIST_MONITOR_NAME = "left"
local playerListMonitor =
    peripheral.wrap(PLAYER_LIST_MONITOR_NAME)
-- Normal display monitors, excluding the dedicated
-- player-list monitor.
local monitors = {}
for _, name in ipairs(peripheral.getNames()) do
    if peripheral.getType(name) == "monitor"
        and name ~= PLAYER_LIST_MONITOR_NAME then
        local monitor = peripheral.wrap(name)
        if monitor then
            monitors[#monitors + 1] = monitor
        end
    end
end
-- =========================================================
-- INITIAL CHECKS
-- =========================================================
if not playerListMonitor then
    error(
        "Player list monitor not found: "
        .. PLAYER_LIST_MONITOR_NAME
    )
end
print(
    "Found "
    .. #radarMonitors
    .. " radar monitor(s)"
)
print(
    #speakers > 0
    and "Found " .. #speakers .. " speaker(s)"
    or "No speaker peripherals found"
)
print(
    #monitors > 0
    and "Found " .. #monitors .. " normal display monitor(s)"
    or "No normal display monitors found"
)
print(
    "Player list monitor: "
    .. PLAYER_LIST_MONITOR_NAME
)
-- =========================================================
-- CONFIGURATION
-- =========================================================
local REDSTONE_SIDE = "top"
-- =========================================================
-- REDSTONE DETECTION AREAS
-- =========================================================
local REDSTONE_DETECTION_AREA = {
    -99, 70, 250, -96, 72, 247
}
local ALLY_RELAY_AREAS = {
    -- Include the existing redstone detection area.
    REDSTONE_DETECTION_AREA,
    -- New ally relay area.
    { -103, 78, 253, -97, 71, 250 }
}
-- =========================================================
-- 200x200 PLAYER DISPLAY BOUNDARY
-- =========================================================
-- This is also used for player ordering.
-- =========================================================
local SQUARE_CENTER_X = -111
local SQUARE_CENTER_Z = 243
local SQUARE_HALF_SIZE = 100
local SQUARE_X1 =
    SQUARE_CENTER_X - SQUARE_HALF_SIZE
local SQUARE_X2 =
    SQUARE_CENTER_X + SQUARE_HALF_SIZE
local SQUARE_Z1 =
    SQUARE_CENTER_Z - SQUARE_HALF_SIZE
local SQUARE_Z2 =
    SQUARE_CENTER_Z + SQUARE_HALF_SIZE
-- =========================================================
-- REDNET
-- =========================================================
local REDNET_SIDE = "bottom"
local DESTINATION_IDS = {
    70,
}
local PROTOCOL = "radar"

-- Web dashboard relay. Use ws:// for a local HTTP server or wss:// for HTTPS.
-- STASIS_TOKEN must match the value in the web server's .env file.
local RADAR_WS_URL = "wss://stasis.suchodupin.com/ws?role=radar&token=YOUR-STASIS_TOKEN"
local radarWebSocket = nil
local nextRadarReconnect = 0

local function sendRadarToWeb(players)
    if not http then return end
    if not radarWebSocket and os.clock() >= nextRadarReconnect then
        local ok, socketOrError = pcall(http.websocket, RADAR_WS_URL)
        if ok and socketOrError then
            radarWebSocket = socketOrError
            print("Connected to Stasis radar WebSocket")
        else
            nextRadarReconnect = os.clock() + 10
            print("Radar WebSocket unavailable; retrying in 10 seconds")
        end
    end
    if radarWebSocket then
        local ok = pcall(function()
            radarWebSocket.send(textutils.serialiseJSON({
                type = "radar",
                players = players,
                timestamp = os.epoch("utc")
            }))
        end)
        if not ok then
            pcall(function() radarWebSocket.close() end)
            radarWebSocket = nil
            nextRadarReconnect = os.clock() + 10
        end
    end
end
-- =========================================================
-- DATABASE
-- =========================================================
local CATEGORY_FILTER = "PLAYER"
local DATABASE_FILE = "users.json"
-- =========================================================
-- REDSTONE AREAS
-- =========================================================
local function isInsideArea(area, x, y, z)
    local minX = math.min(area[1], area[4])
    local maxX = math.max(area[1], area[4])
    local minY = math.min(area[2], area[5])
    local maxY = math.max(area[2], area[5])
    local minZ = math.min(area[3], area[6])
    local maxZ = math.max(area[3], area[6])
    return x >= minX
        and x <= maxX
        and y >= minY
        and y <= maxY
        and z >= minZ
        and z <= maxZ
end
local function isInsideAnyAllyRelayArea(x, y, z)
    for _, area in ipairs(ALLY_RELAY_AREAS) do
        if isInsideArea(area, x, y, z) then
            return true
        end
    end
    return false
end
-- =========================================================
-- PLAYER SQUARE
-- =========================================================
local function isInsidePlayerSquare(x, z)
    return x >= SQUARE_X1
        and x <= SQUARE_X2
        and z >= SQUARE_Z1
        and z <= SQUARE_Z2
end
-- =========================================================
-- FLOOR DETECTION AREA
-- =========================================================
local FLOOR_HALF_SIZE = 50
local FLOOR_X1 =
    SQUARE_CENTER_X - FLOOR_HALF_SIZE
local FLOOR_X2 =
    SQUARE_CENTER_X + FLOOR_HALF_SIZE
local FLOOR_Z1 =
    SQUARE_CENTER_Z - FLOOR_HALF_SIZE
local FLOOR_Z2 =
    SQUARE_CENTER_Z + FLOOR_HALF_SIZE
local function isWithinFloorSquare(x, z)
    return x >= FLOOR_X1
        and x <= FLOOR_X2
        and z >= FLOOR_Z1
        and z <= FLOOR_Z2
end
-- =========================================================
-- FLOOR DETECTION
-- =========================================================
local function getPlayerFloor(y)
    if y >= 68 and y <= 71 then
        return "TOP"
    elseif y >= 56 and y <= 64 then
        return "PWR"
    elseif y >= 38 and y <= 46 then
        return "NWF"
    elseif y >= 29 and y <= 33 then
        return "SRV"
    elseif y >= 22 and y <= 27 then
        return "MAIN"
    elseif y >= 12 and y <= 18 then
        return "MCH"
    elseif y >= -11 and y <= -7 then
        return "LAVA"
    elseif y < -20 then
        return "MINE"
    end
    return nil
end
-- =========================================================
-- FLOOR REDSTONE RELAYS
-- =========================================================
-- 41=TOP, 42=PWR, 43=NWF, 44=SRV, 45=MAIN, 46=MCH, 47=LAVA, 48=MINE
local FLOOR_RELAYS = {
    TOP = peripheral.wrap("redstone_relay_41"),
    PWR = peripheral.wrap("redstone_relay_42"),
    NWF = peripheral.wrap("redstone_relay_43"),
    SRV = peripheral.wrap("redstone_relay_44"),
    MAIN = peripheral.wrap("redstone_relay_45"),
    MCH = peripheral.wrap("redstone_relay_46"),
    LAVA = peripheral.wrap("redstone_relay_47"),
    MINE = peripheral.wrap("redstone_relay_48")
}
local function setFloorRelay(relay, enabled)
    if relay then relay.setOutput("top", enabled) end
end
local function setRelayFront(relay, enabled)
    if relay then relay.setOutput("front", enabled) end
end
local function clearFloorRelays()
    for _, relay in pairs(FLOOR_RELAYS) do setFloorRelay(relay, false) end
end
local FLOOR_ORDER = { "TOP", "PWR", "NWF", "SRV", "MAIN", "MCH", "LAVA", "MINE" }
local function updateFloorRelays(players)
    clearFloorRelays()
    local active = {}
    for _, player in ipairs(players) do
        if player.floor and FLOOR_RELAYS[player.floor] then
            setFloorRelay(FLOOR_RELAYS[player.floor], true)
            active[player.floor] = true
        end
    end
    local activeFloors = {}
    for _, floor in ipairs(FLOOR_ORDER) do
        if active[floor] then activeFloors[#activeFloors + 1] = floor end
    end
    term.setTextColor(colors.lime)
    if #activeFloors > 0 then
        print("Active floors: " .. table.concat(activeFloors, ", "))
    else
        print("Active floors: none")
    end
    term.setTextColor(colors.white)
end
clearFloorRelays()
setRelayFront(FLOOR_RELAYS.TOP, false)
redstone.setOutput(
    REDSTONE_SIDE,
    false
)
-- =========================================================
-- REDNET
-- =========================================================
local modem =
    peripheral.wrap(REDNET_SIDE)
local rednetEnabled =
    modem
    and modem.isWireless
    and modem.isWireless()
if rednetEnabled then
    if not rednet.isOpen(REDNET_SIDE) then
        rednet.open(REDNET_SIDE)
    end
    print(
        "Rednet enabled on "
        .. REDNET_SIDE
    )
else
    print(
        "No wireless modem found on "
        .. REDNET_SIDE
    )
    print(
        "Rednet disabled - scanner will work without it"
    )
end
local remotePlayers = {}
-- =========================================================
-- DATABASE
-- =========================================================
local function loadDatabase(fileName)
    if not fs.exists(fileName) then
        error(
            "NO "
            .. fileName
            .. " file!"
        )
    end
    local file =
        fs.open(
            fileName,
            "r"
        )
    local data =
        textutils.unserialiseJSON(
            file.readAll()
        )
    file.close()
    if type(data) ~= "table" then
        error(
            "Invalid JSON in "
            .. fileName
        )
    end
    return data
end
local USERNAME_LIST =
    loadDatabase(
        DATABASE_FILE
    )
local nameCache = {}
local function saveDatabase()
    local file =
        fs.open(
            DATABASE_FILE,
            "w"
        )
    if not file then
        print(
            "Failed to open "
            .. DATABASE_FILE
            .. " for writing"
        )
        return false
    end
    file.write(
        textutils.serialiseJSON(
            USERNAME_LIST
        )
    )
    file.close()
    return true
end
-- =========================================================
-- PLAYER MENU HELPERS
-- =========================================================
local function getPlayerList()
    local players = {}
    for username, status in pairs(USERNAME_LIST) do
        players[#players + 1] = {
            username = username,
            status = status
        }
    end
    table.sort(
        players,
        function(a, b)
            return a.username:lower()
                < b.username:lower()
        end
    )
    players[#players + 1] = {
        username = "Add Player",
        status = "add"
    }
    return players
end
local function getStatusName(status)
    return status or "unknown"
end
local function drawMenuItem(
    y,
    text,
    selected,
    color
)
    term.setCursorPos(
        2,
        y
    )
    if selected then
        term.setBackgroundColor(
            colors.gray
        )
        term.setTextColor(
            colors.white
        )
    else
        term.setBackgroundColor(
            colors.black
        )
        term.setTextColor(
            color or colors.white
        )
    end
    term.clearLine()
    term.write(
        selected
        and "> " .. text
        or "  " .. text
    )
    term.setBackgroundColor(
        colors.black
    )
end
local function waitForKey()
    while true do
        local event, key =
            os.pullEvent("key")
        if key == keys.c then
            error("Terminated")
        end
        return key
    end
end
-- =========================================================
-- STATUS SELECTOR
-- =========================================================
local function statusMenu(
    username,
    currentStatus
)
    local options = {
        {
            name = "Enemy",
            value = "enemy",
            color = colors.red
        },
        {
            name = "Ally",
            value = "ally",
            color = colors.blue
        },
        {
            name = "Team",
            value = "team",
            color = colors.green
        },
        {
            name = "Unknown",
            value = nil,
            color = colors.yellow
        },
        {
            name = "Remove Player",
            value = "remove",
            color = colors.red
        },
        {
            name = "Back",
            value = "back",
            color = colors.white
        }
    }
    local selected = 1
    while true do
        term.clear()
        term.setCursorPos(1, 1)
        print("===============================")
        print("         PLAYER STATUS         ")
        print("===============================")
        print("")
        print(
            "Player: "
            .. username
        )
        print(
            "Current: "
            .. getStatusName(currentStatus)
        )
        print("")
        for i, option in ipairs(options) do
            drawMenuItem(
                i + 5,
                option.name,
                i == selected,
                option.color
            )
        end
        term.setCursorPos(
            1,
            #options + 8
        )
        term.setTextColor(
            colors.lightGray
        )
        term.write(
            "Arrow keys: Navigate   Enter: Select"
        )
        term.setCursorPos(
            1,
            #options + 9
        )
        term.write(
            "Esc: Back   C: Terminate"
        )
        local event, key =
            os.pullEvent()
        if event == "key" then
            if key == keys.c then
                error("Terminated")
            elseif key == keys.up then
                selected =
                    selected > 1
                    and selected - 1
                    or #options
            elseif key == keys.down then
                selected =
                    selected < #options
                    and selected + 1
                    or 1
            elseif key == keys.enter then
                local option =
                    options[selected]
                if option.value == "back" then
                    return
                elseif option.value == "remove" then
                    term.clear()
                    term.setCursorPos(1, 1)
                    print(
                        "Remove "
                        .. username
                        .. "?"
                    )
                    print("")
                    print(
                        "Press Y to confirm."
                    )
                    print(
                        "Press any other key to cancel."
                    )
                    while true do
                        local confirmEvent,
                            confirmKey =
                            os.pullEvent(
                                "key"
                            )
                        if confirmKey == keys.c then
                            error("Terminated")
                        elseif confirmKey == keys.y then
                            USERNAME_LIST[username] =
                                nil
                            saveDatabase()
                            print("")
                            print(
                                "Player removed."
                            )
                            sleep(1)
                            return
                        else
                            return
                        end
                    end
                else
                    local oldStatus =
                        USERNAME_LIST[username]
                    USERNAME_LIST[username] =
                        option.value
                    if saveDatabase() then
                        currentStatus =
                            option.value
                        term.setCursorPos(
                            1,
                            #options + 11
                        )
                        term.setTextColor(
                            colors.lime
                        )
                        print(
                            "Status saved."
                        )
                        sleep(0.7)
                    else
                        USERNAME_LIST[username] =
                            oldStatus
                        term.setCursorPos(
                            1,
                            #options + 11
                        )
                        term.setTextColor(
                            colors.red
                        )
                        print(
                            "Failed to save status."
                        )
                        sleep(1)
                    end
                end
            elseif key == keys.backspace then
                return
            end
        elseif event == "key_up" then
            -- Ignore key release
        end
    end
end
-- =========================================================
-- ADD PLAYER
-- =========================================================
local function addPlayer()
    term.clear()
    term.setCursorPos(1, 1)
    print("===============================")
    print("          ADD PLAYER           ")
    print("===============================")
    print("")
    print(
        "Press Enter without typing to cancel."
    )
    print("")
    write("Username: ")
    local username = read()
    if username == "" then
        return
    end
    if USERNAME_LIST[username] ~= nil then
        print("")
        print(
            "Player already exists."
        )
        sleep(1)
        return
    end
    -- New players start as unknown
    USERNAME_LIST[username] = nil
    local options = {
        {
            name = "Enemy",
            value = "enemy",
            color = colors.red
        },
        {
            name = "Ally",
            value = "ally",
            color = colors.blue
        },
        {
            name = "Team",
            value = "team",
            color = colors.green
        },
        {
            name = "Unknown",
            value = "unknown",
            color = colors.yellow
        }
    }
    local selected = 1
    while true do
        term.clear()
        term.setCursorPos(1, 1)
        print("===============================")
        print("         PLAYER STATUS         ")
        print("===============================")
        print("")
        print(
            "Player: "
            .. username
        )
        print("")
        for i, option in ipairs(options) do
            drawMenuItem(
                i + 5,
                option.name,
                i == selected,
                option.color
            )
        end
        term.setCursorPos(
            1,
            11
        )
        term.setTextColor(
            colors.lightGray
        )
        term.write(
            "Arrow keys: Navigate   Enter: Select"
        )
        term.setCursorPos(
            1,
            12
        )
        term.write(
            "Esc: Cancel   C: Terminate"
        )
        local event, key =
            os.pullEvent()
        if event == "key" then
            if key == keys.c then
                error("Terminated")
            elseif key == keys.up then
                selected =
                    selected > 1
                    and selected - 1
                    or #options
            elseif key == keys.down then
                selected =
                    selected < #options
                    and selected + 1
                    or 1
            elseif key == keys.enter then
                local option =
                    options[selected]
                if option.value == "unknown" then
                    print("")
                    print(
                        "Unknown players are not stored."
                    )
                    sleep(0.7)
                    return
                end
                USERNAME_LIST[username] =
                    option.value
                if saveDatabase() then
                    print("")
                    print(
                        "Player added."
                    )
                else
                    USERNAME_LIST[username] =
                        nil
                    print("")
                    print(
                        "Failed to save player."
                    )
                end
                sleep(1)
                return
            elseif key == keys.backspace then
                return
            end
        end
    end
end
local function getPlayerColor(status)
    if status == "team" then
        return colors.green
    elseif status == "enemy" then
        return colors.red
    elseif status == "ally" then
        return colors.blue
    end
    return colors.lightGray
end
-- =========================================================
-- PLAYER LIST MENU
-- =========================================================
local function playerMenu()
    local selected = 1
    local scrollOffset = 0
    while true do
        local playerList =
            getPlayerList()
        local width, height =
            term.getSize()
        local firstLine = 3
        local lastLine = height - 2
        local visibleCount =
            math.max(
                1,
                lastLine - firstLine + 1
            )
        if selected - scrollOffset
            > visibleCount then
            scrollOffset =
                selected - visibleCount
        elseif selected - scrollOffset < 1 then
            scrollOffset =
                selected - 1
        end
        local maxScroll =
            math.max(
                0,
                #playerList - visibleCount
            )
        scrollOffset =
            math.min(
                scrollOffset,
                maxScroll
            )
        term.clear()
        term.setCursorPos(
            1,
            1
        )
        term.setTextColor(
            colors.white
        )
        term.write(
            "Player Management"
        )
        for i = 1, visibleCount do
            local index =
                i + scrollOffset
            if index <= #playerList then
                local player =
                    playerList[index]
                local status =
                    player.status
                local text
                local color
                if player.status == "add" then
                    text = "Add Player"
                    color = colors.lime
                else
                    text =
                        player.username
                        .. " ["
                        .. getStatusName(status)
                        .. "]"
                    color =
                        getPlayerColor(status)
                end
                drawMenuItem(
                    firstLine + i - 1,
                    text,
                    index == selected,
                    color
                )
            end
        end
        if scrollOffset > 0 then
            term.setCursorPos(
                width,
                firstLine
            )
            term.setTextColor(
                colors.white
            )
            term.write("^")
        end
        if scrollOffset < maxScroll then
            term.setCursorPos(
                width,
                lastLine
            )
            term.setTextColor(
                colors.white
            )
            term.write("v")
        end
        term.setCursorPos(
            1,
            height
        )
        term.setTextColor(
            colors.lightGray
        )
        term.write(
            "Up/Down: Navigate  Enter: Select  Backspace: Back"
        )
        local event, key =
            os.pullEvent()
        if event == "key" then
            if key == keys.c then
                error("Terminated")
            elseif key == keys.up then
                if selected > 1 then
                    selected =
                        selected - 1
                end
            elseif key == keys.down then
                if selected < #playerList then
                    selected =
                        selected + 1
                end
            elseif key == keys.enter then
                local player =
                    playerList[selected]
                if player.status == "add" then
                    addPlayer()
                else
                    statusMenu(
                        player.username,
                        player.status
                    )
                end
            elseif key == keys.backspace then
                term.setTextColor(
                    colors.white
                )
                return
            end
        end
    end
end
-- =========================================================
-- UUID -> USERNAME
-- =========================================================
local function resolveUsernameFromUUID(uuid)
    if not uuid
        or uuid == "" then
        return nil
    end
    if not http then return nil end
    if nameCache[uuid] ~= nil then
        return nameCache[uuid] or nil
    end
    local res, err =
        http.get(
            "https://playerdb.co/api/player/minecraft/"
            .. uuid
        )
    if not res then
        print(
            "HTTP fail for "
            .. uuid
            .. ": "
            .. tostring(err)
        )
        nameCache[uuid] = false
        return nil
    end
    local body =
        res.readAll()
    res.close()
    local ok, data =
        pcall(
            textutils.unserialiseJSON,
            body
        )
    if not ok
        or type(data) ~= "table" then
        print(
            "Bad JSON for "
            .. uuid
        )
        nameCache[uuid] = false
        return nil
    end
    local username =
        data.data
        and data.data.player
        and data.data.player.username
    if type(username) == "string"
        and username ~= "" then
        nameCache[uuid] =
            username
        return username
    end
    nameCache[uuid] = false
    return nil
end

-- Accept the same { data = { { username, x, y, z, ... } } }
-- packet shape this program used to broadcast. Each sending computer
-- replaces its previous snapshot so clients do not accumulate stale rows.
local function acceptRadarMessage(sender, message)
    if type(message) ~= "table" or type(message.data) ~= "table" then
        return false
    end
    local snapshot = {}
    for _, row in ipairs(message.data) do
        if type(row) == "table"
            and type(row.username) == "string"
            and #row.username > 0 and #row.username <= 32 then
            local x, y, z = tonumber(row.x), tonumber(row.y), tonumber(row.z)
            if x and y and z then
                snapshot[#snapshot + 1] = {
                    username = row.username,
                    x = x, y = y, z = z,
                    status = USERNAME_LIST[row.username],
                    floor = type(row.floor) == "string" and row.floor or nil,
                    outOfBounds = not isInsidePlayerSquare(x, z)
                }
            end
        end
    end
    remotePlayers[sender] = { players = snapshot, receivedAt = os.clock() }
    return true
end
-- =========================================================
-- RADAR TRACKS
-- =========================================================
local function getAllTracks()
    local tracks = {}
    local seen = {}
    for _, radar in ipairs(radarMonitors) do
        for _, track in ipairs(
            radar.getTracks() or {}
        ) do
            if track.category ==
                CATEGORY_FILTER then
                local id = track.id
                if not id
                    or id == ""
                    or not seen[id] then
                    if id
                        and id ~= "" then
                        seen[id] = true
                    end
                    tracks[#tracks + 1] =
                        track
                end
            end
        end
    end
    return tracks
end
-- =========================================================
-- PLAYER HELPERS
-- =========================================================
local function getStatusPriority(status)
    if status == "enemy" then
        return 1
    elseif status == nil then
        return 2
    elseif status == "ally" then
        return 3
    elseif status == "team" then
        return 4
    end
    return 2
end
local function formatPlayer(player)
    local marker = ""
    if player.status == "enemy" then
        marker = " !"
    elseif player.status == nil then
        marker = " ?"
    end
    local floorText = ""
    if player.floor ~= nil then
        floorText =
            " "
            .. player.floor
    end
    return (
        "%s %.0f %.0f %.0f%s%s"
    ):format(
        player.username,
        player.x,
        player.y,
        player.z,
        marker,
        floorText
    )
end
-- =========================================================
-- NORMAL DISPLAY MONITORS
-- =========================================================
local function updateMonitors(players)
    for _, monitor in ipairs(monitors) do
        monitor.setBackgroundColor(
            colors.black
        )
        monitor.clear()
        monitor.setTextScale(1)
        local width, height =
            monitor.getSize()
        monitor.setCursorPos(
            1,
            1
        )
        monitor.setTextColor(
            colors.white
        )
        monitor.write(
            "---- RADAR ----"
        )
        for line, player in ipairs(players) do
            if line >= height then
                break
            end
            -- Keep normal monitors behaving like before:
            -- players outside the 200x200 area are gray,
            -- players inside keep their status colors.
            if player.outOfBounds then
                monitor.setTextColor(
                    colors.gray
                )
            else
                monitor.setTextColor(
                    getPlayerColor(
                        player.status
                    )
                )
            end
            local text =
                formatPlayer(player)
            monitor.setCursorPos(
                1,
                line + 1
            )
            monitor.write(
                text:sub(
                    1,
                    width
                )
            )
        end
        monitor.setTextColor(
            colors.white
        )
    end
end
-- =========================================================
-- PLAYER LIST MONITOR
-- =========================================================
local function updatePlayerListMonitor(players)
    local monitor = playerListMonitor
    if not monitor then
        return
    end
    monitor.setBackgroundColor(colors.black)
    monitor.setTextScale(1)
    monitor.clear()
    local width, height = monitor.getSize()
    -- Header
    monitor.setCursorPos(1, 1)
    monitor.setTextColor(colors.white)
    monitor.write(("1. nick x y z level status distance"):sub(1, width))
    -- Header separator
    if height >= 2 then
        monitor.setCursorPos(1, 2)
        monitor.setTextColor(colors.gray)
        monitor.write(string.rep("-", width))
    end
    local line = 3
    -- Draw one distance group. Every player row gets its normal
    -- status color, including players outside the 200x200 square.
    local function drawGroup(isOutside)
        for index, player in ipairs(players) do
            if player.outOfBounds == isOutside then
                if line > height then
                    return
                end
                local dx = player.x - SQUARE_CENTER_X
                local dz = player.z - SQUARE_CENTER_Z
                local distance = math.sqrt(dx * dx + dz * dz)
                local xText = string.format("%.1f", player.x)
                local yText = string.format("%.1f", player.y)
                local zText = string.format("%.1f", player.z)
                local distanceText = string.format("%.1f", distance)
                local statusSymbol = ""
                if player.status == "enemy" then
                    statusSymbol = "!"
                elseif player.status == nil then
                    statusSymbol = "?"
                end
                local levelText = ""
                if not isOutside and player.floor then
                    levelText = player.floor
                end
                local text
                if levelText ~= "" then
                    text = string.format(
                        "%d. %s %s %s %s %s %s %s",
                        index,
                        player.username,
                        xText,
                        yText,
                        zText,
                        levelText,
                        statusSymbol,
                        distanceText
                    )
                else
                    text = string.format(
                        "%d. %s %s %s %s %s %s",
                        index,
                        player.username,
                        xText,
                        yText,
                        zText,
                        statusSymbol,
                        distanceText
                    )
                end
                monitor.setCursorPos(1, line)
                -- Use the player's status color in BOTH groups.
                -- Distance / 200x200 membership does not change the color.
                monitor.setTextColor(
                    getPlayerColor(player.status)
                )
                monitor.write(text:sub(1, width))
                line = line + 1
            end
        end
    end
    -- Group 1: players inside the 200x200 square.
    drawGroup(false)
    -- Single separator between group 1 and group 2.
    if line <= height then
        monitor.setCursorPos(1, line)
        monitor.setTextColor(colors.gray)
        monitor.write(string.rep("-", width))
        line = line + 1
    end
    -- Group 2: players outside the 200x200 square.
    -- These rows are colored exactly the same way as group 1.
    drawGroup(true)
    monitor.setTextColor(colors.white)
end
-- =========================================================
-- MAIN LOOP
-- =========================================================
local function run()
    while true do
        term.clear()
        term.setCursorPos(1, 1)
        local tracks = #radarMonitors > 0 and getAllTracks() or {}
        local speakerMatched = false
        local redstoneMatched = false
        local allyRelayMatched = false
        local detectedPlayers = {}
        print("---- Scan ----")
        print(
            "C = terminate | M = player menu"
        )
        print(
            "Radar monitors: "
            .. #radarMonitors
        )
        print(
            "Normal display monitors: "
            .. #monitors
        )
        print(
            "Player list monitor: "
            .. PLAYER_LIST_MONITOR_NAME
        )
        print(
            "Unique players: "
            .. #tracks
        )
        print("")
        -- =================================================
        -- READ RADAR
        -- =================================================
        for _, track in ipairs(tracks) do
            local username =
                resolveUsernameFromUUID(
                    track.id or ""
                )
            local pos =
                track.position or {}
            local x =
                pos.x or 0
            local y =
                pos.y or 0
            local z =
                pos.z or 0
            if username then
                local status =
                    USERNAME_LIST[username]
                -- Speaker detection
                if status == "enemy"
                    and isInsidePlayerSquare(
                        x,
                        z
                    ) then
                    speakerMatched = true
                end
                -- Redstone detection
                if status == "enemy"
                    and isInsideArea(
                        REDSTONE_DETECTION_AREA,
                        x,
                        y,
                        z
                    ) then
                    redstoneMatched = true
                end
                -- Enable relay 41's front output for allies in either
                -- redstone detection area.
                if (status == "ally" or status == "team")
                    and isInsideAnyAllyRelayArea(
                        x,
                        y,
                        z
                    ) then
                    allyRelayMatched = true
                end
                detectedPlayers[
                    #detectedPlayers + 1
                ] = {
                    username = username,
                    x = x,
                    y = y,
                    z = z,
                    floor =
                        isWithinFloorSquare(
                            x,
                            z
                        )
                        and getPlayerFloor(y)
                        or nil,
                    status = status,
                    outOfBounds =
                        not isInsidePlayerSquare(
                            x,
                            z
                        )
                }
            end
        end
        -- Add the latest snapshot from every remote sender. If a player is
        -- also visible locally, prefer the local radar coordinates.
        local detectedNames = {}
        for _, player in ipairs(detectedPlayers) do
            detectedNames[player.username:lower()] = true
        end
        for sender, remote in pairs(remotePlayers) do
            if os.clock() - remote.receivedAt > 10 then
                remotePlayers[sender] = nil
            else
            for _, player in ipairs(remote.players) do
                local key = player.username:lower()
                if not detectedNames[key] then
                    detectedPlayers[#detectedPlayers + 1] = player
                    detectedNames[key] = true
                end
            end
            end
        end
        -- =================================================
        -- SORT
        -- =================================================
        --
        -- Same ordering as the server monitor:
        --
        -- 1. Inside 200x200
        -- 2. Outside 200x200 by distance
        -- 3. Status priority
        -- 4. Username
        --
        -- Status:
        -- enemy -> unknown -> ally -> team
        -- =================================================
        table.sort(
            detectedPlayers,
            function(a, b)
                if a.outOfBounds
                    ~= b.outOfBounds then
                    return not a.outOfBounds
                end
                if a.outOfBounds
                    and b.outOfBounds then
                    local dxA =
                        a.x
                        - SQUARE_CENTER_X
                    local dzA =
                        a.z
                        - SQUARE_CENTER_Z
                    local distanceA =
                        dxA * dxA
                        + dzA * dzA
                    local dxB =
                        b.x
                        - SQUARE_CENTER_X
                    local dzB =
                        b.z
                        - SQUARE_CENTER_Z
                    local distanceB =
                        dxB * dxB
                        + dzB * dzB
                    if distanceA
                        ~= distanceB then
                        return distanceA
                            < distanceB
                    end
                end
                local priorityA =
                    getStatusPriority(
                        a.status
                    )
                local priorityB =
                    getStatusPriority(
                        b.status
                    )
                if priorityA
                    ~= priorityB then
                    return priorityA
                        < priorityB
                end
                return a.username:lower()
                    < b.username:lower()
            end
        )
        -- =================================================
        -- BUILD ORDERED RADAR DATA
        -- =================================================
        --
        -- Status is included.
        -- Coordinates are sent as strings with 2 decimals.
        -- The array preserves the sorted order.
        -- =================================================
        local radarData = {}
        for _, player in ipairs(
            detectedPlayers
        ) do
            radarData[
                #radarData + 1
            ] = {
                username = player.username,
                x = (
                    "%.2f"
                ):format(
                    player.x
                ),
                y = (
                    "%.2f"
                ):format(
                    player.y
                ),
                z = (
                    "%.2f"
                ):format(
                    player.z
                ),
                status = player.status,
                floor = player.floor,
                outOfBounds =
                player.outOfBounds
            }
        end
        sendRadarToWeb(radarData)
        -- =================================================
        -- COMPUTER TERMINAL
        -- =================================================
        for _, player in ipairs(
            detectedPlayers
        ) do
            -- Keep the player's status color at every distance.
            term.setTextColor(
                getPlayerColor(
                    player.status
                )
            )
            print(
                formatPlayer(player)
            )
        end
        term.setTextColor(
            colors.white
        )
        -- =================================================
        -- NORMAL DISPLAY MONITORS
        -- =================================================
        updateMonitors(
            detectedPlayers
        )
        -- =================================================
        -- DEDICATED PLAYER LIST MONITOR
        -- =================================================
        updatePlayerListMonitor(
            detectedPlayers
        )
        -- =================================================
        -- FLOOR REDSTONE RELAYS
        -- =================================================
        updateFloorRelays(detectedPlayers)
        setRelayFront(
            FLOOR_RELAYS.TOP,
            allyRelayMatched
        )
        -- =================================================
        -- REDSTONE
        -- =================================================
        redstone.setOutput(
            REDSTONE_SIDE,
            redstoneMatched
        )
        -- =================================================
        -- REDNET
        -- =================================================
        -- Keep broadcasting this computer's scan to configured destinations
        -- while also accepting snapshots from remote radar clients.
        if rednetEnabled then
            local message = {
                data = radarData,
                timestamp = os.epoch("utc")
            }
            for _, destinationID in ipairs(DESTINATION_IDS) do
                local sent = rednet.send(destinationID, message, PROTOCOL)
                print(sent
                    and ("Radar data sent to computer " .. destinationID)
                    or ("Failed to send radar data to computer " .. destinationID))
            end
        else
            print("Rednet unavailable")
        end
        -- =================================================
        -- SPEAKERS
        -- =================================================
        if speakerMatched then
            for _, speaker in ipairs(
                speakers
            ) do
                speaker.playSound(
                    "powergrid:alarm_bell"
                )
            end
        end
        -- =================================================
        -- WAIT
        -- =================================================
        local timer =
            os.startTimer(0.5)
        while true do
            local event, p1, p2, p3 =
                os.pullEvent()
            if event == "key" then
                if p1 == keys.c then
                    error("Terminated")
                elseif p1 == keys.m then
                    playerMenu()
                    break
                end
            elseif event == "timer"
                and p1 == timer then
                break
            elseif event == "rednet_message"
                and p3 == PROTOCOL then
                if acceptRadarMessage(p1, p2) then
                    print("Received radar data from computer " .. tostring(p1))
                end
            end
        end
    end
end
-- =========================================================
-- TERMINATION / CLEANUP
-- =========================================================
local ok, err =
    pcall(run)
redstone.setOutput(
    REDSTONE_SIDE,
    false
)
clearFloorRelays()
setRelayFront(FLOOR_RELAYS.TOP, false)
if not ok then
    if err == "Terminated" then
        print(
            "Program terminated."
        )
    else
        printError(err)
    end
end
