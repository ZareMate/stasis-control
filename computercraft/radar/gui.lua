-- =========================================================
-- RADAR GUI / MONITORS
-- =========================================================
-- This process does ONLY terminal + monitor rendering and the player menu.
-- Radar data comes from radar_state.json.

local STATE_FILE = "radar_state.json"
local DATABASE_FILE = "users.json"
local PLAYER_LIST_MONITOR_NAME = "left"
local GUI_INTERVAL = 0.15

local SQUARE_CENTER_X = -111
local SQUARE_CENTER_Z = 243
local SQUARE_HALF_SIZE = 100

local playerListMonitor = peripheral.wrap(PLAYER_LIST_MONITOR_NAME)
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

local USERNAME_LIST = {}
local lastStateTimestamp = -1

local function loadDatabase()
    if not fs.exists(DATABASE_FILE) then return {} end

    local file = fs.open(DATABASE_FILE, "r")
    if not file then return {} end

    local data = textutils.unserialiseJSON(file.readAll())
    file.close()

    return type(data) == "table" and data or {}
end

local function saveDatabase()
    local file = fs.open(DATABASE_FILE, "w")
    if not file then return false end

    file.write(textutils.serialiseJSON(USERNAME_LIST))
    file.close()
    return true
end

USERNAME_LIST = loadDatabase()

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

local function getStatusName(status)
    return status or "unknown"
end

local function drawMenuItem(y, text, selected, color)
    term.setCursorPos(2, y)

    if selected then
        term.setBackgroundColor(colors.gray)
        term.setTextColor(colors.white)
    else
        term.setBackgroundColor(colors.black)
        term.setTextColor(color or colors.white)
    end

    term.clearLine()
    term.write(selected and "> " .. text or "  " .. text)
    term.setBackgroundColor(colors.black)
end

local function requestStop()
    local file = fs.open("radar_stop", "w")
    if file then
        file.write("stop")
        file.close()
    end
    error("Terminated")
end

local listMenu = dofile("list_menu.lua")

local function statusMenu(username, currentStatus)
    listMenu.open({
        wrap = true,
        firstLine = 8,
        onTerminate = requestStop,
        onBack = function() end,
        header = function(width)
            term.setCursorPos(1, 1)
            term.setTextColor(colors.white)
            print("===============================")
            print("         PLAYER STATUS         ")
            print("===============================")
            print("")
            print("Player: " .. username)
            print("Current: " .. getStatusName(currentStatus))
            print("")
            return 8
        end,
        footer = function(_, height)
            term.setCursorPos(1, height)
            term.setTextColor(colors.lightGray)
            term.write("Up/Down: Navigate   Enter: Select")

            if height > 1 then
                term.setCursorPos(1, height - 1)
                term.write("Backspace: Back   C: Terminate")
            end
        end,
        items = {
            {
                name = "Enemy",
                color = colors.red,
                onConfirm = function()
                    local oldStatus = USERNAME_LIST[username]
                    USERNAME_LIST[username] = "enemy"

                    if saveDatabase() then
                        currentStatus = "enemy"
                        return false
                    end

                    USERNAME_LIST[username] = oldStatus
                    return false
                end
            },
            {
                name = "Ally",
                color = colors.blue,
                onConfirm = function()
                    local oldStatus = USERNAME_LIST[username]
                    USERNAME_LIST[username] = "ally"

                    if saveDatabase() then
                        currentStatus = "ally"
                        return false
                    end

                    USERNAME_LIST[username] = oldStatus
                    return false
                end
            },
            {
                name = "Team",
                color = colors.green,
                onConfirm = function()
                    local oldStatus = USERNAME_LIST[username]
                    USERNAME_LIST[username] = "team"

                    if saveDatabase() then
                        currentStatus = "team"
                        return false
                    end

                    USERNAME_LIST[username] = oldStatus
                    return false
                end
            },
            {
                name = "Unknown",
                color = colors.yellow,
                onConfirm = function()
                    local oldStatus = USERNAME_LIST[username]
                    USERNAME_LIST[username] = nil

                    if saveDatabase() then
                        currentStatus = nil
                        return false
                    end

                    USERNAME_LIST[username] = oldStatus
                    return false
                end
            },
            {
                name = "Remove Player",
                color = colors.red,
                onConfirm = function()
                    term.clear()
                    term.setCursorPos(1, 1)
                    print("Remove " .. username .. "?")
                    print("")
                    print("Press Y to confirm.")
                    print("Press any other key to cancel.")

                    while true do
                        local _, confirmKey = os.pullEvent("key")

                        if confirmKey == keys.c then
                            requestStop()
                        elseif confirmKey == keys.y then
                            USERNAME_LIST[username] = nil
                            saveDatabase()
                            print("")
                            print("Player removed.")
                            sleep(1)
                            return true
                        else
                            return false
                        end
                    end
                end
            }
        }
    })
end

local function addPlayer()
    term.clear()
    term.setCursorPos(1, 1)
    print("===============================")
    print("          ADD PLAYER           ")
    print("===============================")
    print("")
    print("Press Enter without typing to cancel.")
    print("")
    write("Username: ")

    local username = read()

    if username == "" then return end

    if USERNAME_LIST[username] ~= nil then
        print("")
        print("Player already exists.")
        sleep(1)
        return
    end

    listMenu.open({
        wrap = true,
        firstLine = 6,
        onTerminate = requestStop,
        onBack = function() end,
        header = function()
            term.setCursorPos(1, 1)
            term.setTextColor(colors.white)
            print("===============================")
            print("         PLAYER STATUS         ")
            print("===============================")
            print("")
            print("Player: " .. username)
            print("")
            return 6
        end,
        items = {
            {
                name = "Enemy",
                color = colors.red,
                onConfirm = function()
                    USERNAME_LIST[username] = "enemy"

                    if saveDatabase() then
                        print("")
                        print("Player added.")
                    else
                        USERNAME_LIST[username] = nil
                        print("")
                        print("Failed to save player.")
                    end

                    sleep(1)
                    return true
                end
            },
            {
                name = "Ally",
                color = colors.blue,
                onConfirm = function()
                    USERNAME_LIST[username] = "ally"

                    if saveDatabase() then
                        print("")
                        print("Player added.")
                    else
                        USERNAME_LIST[username] = nil
                        print("")
                        print("Failed to save player.")
                    end

                    sleep(1)
                    return true
                end
            },
            {
                name = "Team",
                color = colors.green,
                onConfirm = function()
                    USERNAME_LIST[username] = "team"

                    if saveDatabase() then
                        print("")
                        print("Player added.")
                    else
                        USERNAME_LIST[username] = nil
                        print("")
                        print("Failed to save player.")
                    end

                    sleep(1)
                    return true
                end
            },
            {
                name = "Unknown",
                color = colors.yellow,
                onConfirm = function()
                    print("")
                    print("Unknown players are not stored.")
                    sleep(1)
                    return true
                end
            }
        }
    })
end

local function getPlayerMenuItems()
    local players = {}

    for username, status in pairs(USERNAME_LIST) do
        players[#players + 1] = {
            username = username,
            status = status
        }
    end

    table.sort(players, function(a, b)
        return a.username:lower() < b.username:lower()
    end)

    local items = {}

    for _, player in ipairs(players) do
        items[#items + 1] = {
            name = function()
                return player.username
                    .. " ["
                    .. getStatusName(player.status)
                    .. "]"
            end,
            color = function()
                return getPlayerColor(player.status)
            end,
            onConfirm = function()
                statusMenu(player.username, player.status)
                return false
            end
        }
    end

    items[#items + 1] = {
        name = "Add Player",
        color = colors.lime,
        onConfirm = function()
            addPlayer()
            return false
        end
    }

    return items
end

local function playerMenu()
    listMenu.open({
        wrap = false,
        firstLine = 3,
        onTerminate = requestStop,
        onBack = function()
            term.setTextColor(colors.white)
        end,
        header = function()
            term.setCursorPos(1, 1)
            term.setTextColor(colors.white)
            term.write("Player Management")
            return 3
        end,
        items = function()
            USERNAME_LIST = loadDatabase()
            return getPlayerMenuItems()
        end
    })
end

local function formatPlayer(player)
    local marker = ""

    if player.status == "enemy" then
        marker = " !"
    elseif player.status == nil then
        marker = " ?"
    end

    local floorText = player.floor and " " .. player.floor or ""

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

local function updateMonitors(players)
    for _, monitor in ipairs(monitors) do
        monitor.setBackgroundColor(colors.black)
        monitor.clear()
        monitor.setTextScale(1)

        local width, height = monitor.getSize()
        monitor.setCursorPos(1, 1)
        monitor.setTextColor(colors.white)
        monitor.write("---- RADAR ----")

        for line, player in ipairs(players) do
            if line + 1 >= height then break end

            if player.outOfBounds then
                monitor.setTextColor(colors.gray)
            else
                monitor.setTextColor(getPlayerColor(player.status))
            end

            local text = formatPlayer(player)

            monitor.setCursorPos(1, line + 1)
            monitor.write(text:sub(1, width))
        end

        monitor.setTextColor(colors.white)
    end
end

local function updatePlayerListMonitor(players)
    local monitor = playerListMonitor
    if not monitor then return end

    monitor.setBackgroundColor(colors.black)
    monitor.setTextScale(1)
    monitor.clear()

    local width, height = monitor.getSize()

    monitor.setCursorPos(1, 1)
    monitor.setTextColor(colors.white)
    monitor.write(
        ("1. nick x y z level status distance"):sub(1, width)
    )

    if height >= 2 then
        monitor.setCursorPos(1, 2)
        monitor.setTextColor(colors.gray)
        monitor.write(string.rep("-", width))
    end

    local line = 3

    local function drawGroup(isOutside)
        for index, player in ipairs(players) do
            if player.outOfBounds == isOutside then
                if line > height then return end

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
                monitor.setTextColor(getPlayerColor(player.status))
                monitor.write(text:sub(1, width))
                line = line + 1
            end
        end
    end

    drawGroup(false)

    if line <= height then
        monitor.setCursorPos(1, line)
        monitor.setTextColor(colors.gray)
        monitor.write(string.rep("-", width))
        line = line + 1
    end

    drawGroup(true)
    monitor.setTextColor(colors.white)
end

local function readState()
    if not fs.exists(STATE_FILE) then return nil end

    local file = fs.open(STATE_FILE, "r")
    if not file then return nil end

    local data = textutils.unserialiseJSON(file.readAll())
    file.close()

    return type(data) == "table" and data or nil
end

local function drawTerminal(state)
    term.clear()
    term.setCursorPos(1, 1)

    print("---- Radar GUI ----")
    print("C = terminate | M = player menu")
    print("Radar monitors: scanning in separate tab")
    print("Normal display monitors: " .. #monitors)
    print("Player list monitor: " .. PLAYER_LIST_MONITOR_NAME)
    print("Unique players: " .. tostring(state.tracks or 0))

    local debug = state.debug
    if debug then
        print(string.format(
            "Radar loop: %.3f ms | avg: %.3f ms | max: %.3f ms",
            debug.loopTimeMs or 0,
            debug.avgLoopTimeMs or 0,
            debug.maxLoopTimeMs or 0
        ))

        local phases = debug.phases
        if phases then
            print(string.format(
                "Tracks: %.1f | Names: %.1f | Build: %.1f | Remote: %.1f",
                phases.getTracksMs or 0,
                phases.usernameQueueMs or 0,
                phases.localBuildMs or 0,
                phases.remoteMergeMs or 0
            ))
            print(string.format(
                "Sort: %.1f | SABLE: %.1f | Rednet: %.1f | DB: %.1f",
                phases.sortMs or 0,
                phases.sableMs or 0,
                phases.rawNetworkMs or 0,
                phases.databaseMs or 0
            ))
        end
    end

    print("")

    for _, player in ipairs(state.players or {}) do
        term.setTextColor(getPlayerColor(player.status))
        print(formatPlayer(player))
    end

    term.setTextColor(colors.white)
end

local function run()
    while not fs.exists("radar_stop") do
        local state = readState()

        if state and state.timestamp ~= lastStateTimestamp then
            lastStateTimestamp = state.timestamp
            USERNAME_LIST = loadDatabase()

            drawTerminal(state)
            updateMonitors(state.players or {})
            updatePlayerListMonitor(state.players or {})
        end

        local timer = os.startTimer(GUI_INTERVAL)

        while true do
            local event, p1 = os.pullEvent()

            if event == "key" then
                if p1 == keys.c then
                    requestStop()
                elseif p1 == keys.m then
                    playerMenu()
                    break
                end
            elseif event == "timer" and p1 == timer then
                break
            end

            if fs.exists("radar_stop") then
                return
            end
        end
    end
end

if not playerListMonitor then
    error("Player list monitor not found: " .. PLAYER_LIST_MONITOR_NAME)
end

print("GUI: " .. #monitors .. " normal monitor(s)")
print("GUI: player list monitor = " .. PLAYER_LIST_MONITOR_NAME)

local ok, err = pcall(run)
if not ok and err ~= "Terminated" then
    printError(err)
end
