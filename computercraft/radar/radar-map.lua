-- =========================================================
-- RADAR MAP DISPLAY
-- Computer ID: 70
--
-- MODEM:
--   left
--
-- MAP MONITORS:
--   monitor_26 = TOP LEFT
--   monitor_25 = TOP RIGHT
--   monitor_28 = BOTTOM LEFT
--   monitor_27 = BOTTOM RIGHT
--
-- GROUP MONITOR:
--   The remaining 5th monitor is automatically detected.
--
-- MAP:
--   Four monitors combined into one 2x2 display.
--
-- PLAYER MARKERS:
--   Single player = player number
--   Nearby players = group letter
--
-- GROUPING:
--   Same screen cell
--   Directly adjacent
--   Diagonally adjacent
--
--   Connected groups are supported.
--
-- MAP MONITOR TEXT SCALE:
--   1
-- =========================================================


-- =========================================================
-- CONFIGURATION
-- =========================================================
sleep(1)
local REDNET_SIDE = "left"
local PROTOCOL = "radar"

local MAP_MONITOR_SCALE = 1
local GROUP_MONITOR_SCALE = 1


-- =========================================================
-- MAP CONFIGURATION
-- =========================================================

local MAP_CENTER_X = -111
local MAP_CENTER_Z = 243

local MAP_HALF_SIZE = 4000

local MAP_X1 =
    MAP_CENTER_X - MAP_HALF_SIZE

local MAP_X2 =
    MAP_CENTER_X + MAP_HALF_SIZE

local MAP_Z1 =
    MAP_CENTER_Z - MAP_HALF_SIZE

local MAP_Z2 =
    MAP_CENTER_Z + MAP_HALF_SIZE


local RANGE_RADII = {
    500,
    1000,
    1500,
    2000,
    2500,
    3000,
    3500,
    4000,
    4500
}


-- =========================================================
-- SERVER 200x200 SORTING AREA
-- =========================================================

local SERVER_SQUARE_CENTER_X = -111
local SERVER_SQUARE_CENTER_Z = 243

local SERVER_SQUARE_HALF_SIZE = 100

local SERVER_SQUARE_X1 =
    SERVER_SQUARE_CENTER_X
    - SERVER_SQUARE_HALF_SIZE

local SERVER_SQUARE_X2 =
    SERVER_SQUARE_CENTER_X
    + SERVER_SQUARE_HALF_SIZE

local SERVER_SQUARE_Z1 =
    SERVER_SQUARE_CENTER_Z
    - SERVER_SQUARE_HALF_SIZE

local SERVER_SQUARE_Z2 =
    SERVER_SQUARE_CENTER_Z
    + SERVER_SQUARE_HALF_SIZE


-- =========================================================
-- FIND MONITOR BY ID
-- =========================================================

local function findMonitorByID(id)

    local wantedName =
        "monitor_" .. tostring(id)

    -- Exact name
    if peripheral.isPresent(wantedName) then

        if peripheral.getType(wantedName) == "monitor" then
            return wantedName
        end
    end


    -- Fallback:
    -- Search for a monitor whose name ends with the ID.
    for _, name in ipairs(
        peripheral.getNames()
    ) do

        if peripheral.getType(name) == "monitor" then

            local number =
                name:match("(%d+)$")

            if number == tostring(id) then
                return name
            end
        end
    end


    return nil
end


-- =========================================================
-- FIND THE FOUR MAP MONITORS
-- =========================================================

local topRightName =
    findMonitorByID(25)

local topLeftName =
    findMonitorByID(26)

local bottomRightName =
    findMonitorByID(27)

local bottomLeftName =
    findMonitorByID(28)


if not topRightName then
    error(
        "Could not find monitor 25"
    )
end

if not topLeftName then
    error(
        "Could not find monitor 26"
    )
end

if not bottomRightName then
    error(
        "Could not find monitor 27"
    )
end

if not bottomLeftName then
    error(
        "Could not find monitor 28"
    )
end


-- =========================================================
-- KEEP TRACK OF MAP MONITORS
-- =========================================================

local usedMonitorNames = {

    [topRightName] = true,

    [topLeftName] = true,

    [bottomRightName] = true,

    [bottomLeftName] = true
}


-- =========================================================
-- FIND FIFTH MONITOR FOR GROUPS
-- =========================================================

local groupMonitorName = nil

for _, name in ipairs(
    peripheral.getNames()
) do

    if peripheral.getType(name) == "monitor"
        and not usedMonitorNames[name]
    then

        groupMonitorName = name
        break
    end
end


if not groupMonitorName then

    error(
        "Could not find the 5th monitor for groups"
    )
end


-- =========================================================
-- WRAP MONITORS
-- =========================================================

local topRight =
    peripheral.wrap(
        topRightName
    )

local topLeft =
    peripheral.wrap(
        topLeftName
    )

local bottomRight =
    peripheral.wrap(
        bottomRightName
    )

local bottomLeft =
    peripheral.wrap(
        bottomLeftName
    )

local groupMonitor =
    peripheral.wrap(
        groupMonitorName
    )


if not topRight
    or not topLeft
    or not bottomRight
    or not bottomLeft
    or not groupMonitor
then

    error(
        "Failed to wrap one or more monitors"
    )
end


-- =========================================================
-- SET MONITOR SCALE
-- =========================================================

topRight.setTextScale(
    MAP_MONITOR_SCALE
)

topLeft.setTextScale(
    MAP_MONITOR_SCALE
)

bottomRight.setTextScale(
    MAP_MONITOR_SCALE
)

bottomLeft.setTextScale(
    MAP_MONITOR_SCALE
)

groupMonitor.setTextScale(
    GROUP_MONITOR_SCALE
)


-- =========================================================
-- MONITOR DIMENSIONS
-- =========================================================

local TILE_WIDTH,
    TILE_HEIGHT =
    topLeft.getSize()


local trWidth,
    trHeight =
    topRight.getSize()

local brWidth,
    brHeight =
    bottomRight.getSize()

local blWidth,
    blHeight =
    bottomLeft.getSize()


if trWidth ~= TILE_WIDTH
    or trHeight ~= TILE_HEIGHT
    or brWidth ~= TILE_WIDTH
    or brHeight ~= TILE_HEIGHT
    or blWidth ~= TILE_WIDTH
    or blHeight ~= TILE_HEIGHT
then

    error(
        "All four map monitors must have the same size"
    )
end


-- =========================================================
-- VIRTUAL MAP SIZE
-- =========================================================

local MAP_SCREEN_WIDTH =
    TILE_WIDTH * 2

local MAP_SCREEN_HEIGHT =
    TILE_HEIGHT * 2


-- =========================================================
-- GLOBAL POSITION -> MONITOR
-- =========================================================

local function getMonitorForPosition(
    globalX,
    globalY
)

    -- LEFT half
    if globalX <= TILE_WIDTH then

        -- TOP LEFT
        if globalY <= TILE_HEIGHT then

            return topLeft

        -- BOTTOM LEFT
        else

            return bottomLeft
        end


    -- RIGHT half
    else

        -- TOP RIGHT
        if globalY <= TILE_HEIGHT then

            return topRight

        -- BOTTOM RIGHT
        else

            return bottomRight
        end
    end
end


-- =========================================================
-- GLOBAL -> LOCAL MONITOR POSITION
-- =========================================================

local function globalToLocal(
    globalX,
    globalY
)

    local monitor =
        getMonitorForPosition(
            globalX,
            globalY
        )


    local localX =
        globalX

    local localY =
        globalY


    -- Right monitors
    if globalX > TILE_WIDTH then

        localX =
            globalX
            - TILE_WIDTH
    end


    -- Bottom monitors
    if globalY > TILE_HEIGHT then

        localY =
            globalY
            - TILE_HEIGHT
    end


    return monitor,
        localX,
        localY
end


-- =========================================================
-- MODEM
-- =========================================================

local modem =
    peripheral.wrap(
        REDNET_SIDE
    )


if not modem then

    error(
        "No modem found on "
        .. REDNET_SIDE
    )
end


if not modem.isWireless
    or not modem.isWireless()
then

    error(
        "Modem on "
        .. REDNET_SIDE
        .. " is not wireless"
    )
end


if not rednet.isOpen(
    REDNET_SIDE
) then

    rednet.open(
        REDNET_SIDE
    )
end


-- =========================================================
-- STATUS COLORS
-- =========================================================

local function getPlayerColor(
    status
)

    if status == "enemy" then

        return colors.red

    elseif status == "ally" then

        return colors.blue

    elseif status == "team" then

        return colors.green
    end


    return colors.lightGray
end


-- =========================================================
-- STATUS PRIORITY
-- =========================================================

local function getStatusPriority(
    status
)

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


-- =========================================================
-- SERVER AREA CHECK
-- =========================================================

local function isInsideServerSquare(
    x,
    z
)

    return x >= SERVER_SQUARE_X1
        and x <= SERVER_SQUARE_X2
        and z >= SERVER_SQUARE_Z1
        and z <= SERVER_SQUARE_Z2
end


-- =========================================================
-- DISTANCE FROM SERVER CENTER
-- =========================================================

local function getDistanceSquared(
    x,
    z
)

    local dx =
        x - SERVER_SQUARE_CENTER_X

    local dz =
        z - SERVER_SQUARE_CENTER_Z


    return dx * dx + dz * dz
end


-- =========================================================
-- BUILD PLAYER LIST
-- =========================================================

local function buildPlayerList(
    radarData
)

    local players = {}


    for i, player
        in ipairs(radarData)
    do

        if type(player) == "table" then

            local x =
                tonumber(player.x)

            local y =
                tonumber(player.y)

            local z =
                tonumber(player.z)


            if x and y and z then

                local inside =
                    isInsideServerSquare(
                        x,
                        z
                    )


                players[
                    #players + 1
                ] = {

                    username = tostring(
                        player.username
                        or (
                            "Player "
                            .. i
                        )
                    ),

                    x = x,
                    y = y,
                    z = z,

                    status =
                        player.status,

                    floor =
                        player.floor,

                    outOfBounds =
                        not inside,

                    distance =
                        getDistanceSquared(
                            x,
                            z
                        )
                }
            end
        end
    end


    -- =====================================================
    -- SORT
    -- =====================================================

    table.sort(
        players,
        function(a, b)

            if a.outOfBounds
                ~= b.outOfBounds
            then

                return not a.outOfBounds
            end


            if a.outOfBounds
                and b.outOfBounds
            then

                if a.distance
                    ~= b.distance
                then

                    return a.distance
                        < b.distance
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
                ~= priorityB
            then

                return priorityA
                    < priorityB
            end


            return a.username:lower()
                < b.username:lower()
        end
    )


    return players
end


-- =========================================================
-- WORLD -> VIRTUAL MAP
-- =========================================================

local function worldToMap(
    worldX,
    worldZ
)

    local normalizedX =
        (worldX - MAP_X1)
        / (MAP_X2 - MAP_X1)

    local normalizedZ =
        (worldZ - MAP_Z1)
        / (MAP_Z2 - MAP_Z1)


    local screenX =
        math.floor(
            normalizedX
            * (MAP_SCREEN_WIDTH - 1)
            + 1.5
        )


    local screenY =
        math.floor(
            normalizedZ
            * (MAP_SCREEN_HEIGHT - 1)
            + 1.5
        )


    return screenX,
        screenY
end


-- =========================================================
-- SAFE GLOBAL TEXT DRAW
-- =========================================================

local function safeGlobalWrite(
    globalX,
    globalY,
    text,
    color
)

    text =
        tostring(text)


    -- Keep position inside the virtual map
    if globalX < 1 then
        globalX = 1
    end

    if globalY < 1 then
        globalY = 1
    end

    if globalX > MAP_SCREEN_WIDTH then
        globalX =
            MAP_SCREEN_WIDTH
    end

    if globalY > MAP_SCREEN_HEIGHT then
        globalY =
            MAP_SCREEN_HEIGHT
    end


    -- IMPORTANT:
    -- globalToLocal() returns:
    --
    --   monitor, localX, localY
    --
    local monitor,
        localX,
        localY =
        globalToLocal(
            globalX,
            globalY
        )


    -- Prevent the text from crossing
    -- the monitor boundary.
    local remaining =
        TILE_WIDTH
        - localX
        + 1


    if remaining < #text then

        globalX =
            globalX
            - (
                #text
                - remaining
            )


        if globalX < 1 then
            globalX = 1
        end


        -- IMPORTANT:
        -- Capture all three return values again.
        monitor,
            localX,
            localY =
            globalToLocal(
                globalX,
                globalY
            )
    end


    local remainingText =
        TILE_WIDTH
        - localX
        + 1


    if remainingText < 1 then
        return
    end


    text =
        text:sub(
            1,
            remainingText
        )


    monitor.setCursorPos(
        localX,
        localY
    )


    monitor.setBackgroundColor(
        colors.black
    )


    monitor.setTextColor(
        color or colors.white
    )


    monitor.write(
        text
    )
end


-- =========================================================
-- DRAW GLOBAL PIXEL
-- =========================================================

local function drawGlobalPixel(
    globalX,
    globalY,
    color
)

    if globalX < 1
        or globalX > MAP_SCREEN_WIDTH
        or globalY < 1
        or globalY > MAP_SCREEN_HEIGHT
    then

        return
    end


    local monitor,
        localX,
        localY =
        globalToLocal(
            globalX,
            globalY
        )


    local previousTerm =
        term.redirect(
            monitor
        )


    paintutils.drawPixel(
        localX,
        localY,
        color
    )


    term.redirect(
        previousTerm
    )
end


-- =========================================================
-- DRAW MAP SQUARE
-- =========================================================

local function drawMapSquare()

    local leftX =
        worldToMap(
            MAP_CENTER_X
            - SERVER_SQUARE_HALF_SIZE,
            MAP_CENTER_Z
        )


    local rightX =
        worldToMap(
            MAP_CENTER_X
            + SERVER_SQUARE_HALF_SIZE,
            MAP_CENTER_Z
        )


    local _,
        topY =
        worldToMap(
            MAP_CENTER_X,
            MAP_CENTER_Z
            - SERVER_SQUARE_HALF_SIZE
        )


    local _,
        bottomY =
        worldToMap(
            MAP_CENTER_X,
            MAP_CENTER_Z
            + SERVER_SQUARE_HALF_SIZE
        )


    leftX =
        math.max(
            1,
            math.min(
                MAP_SCREEN_WIDTH,
                leftX
            )
        )


    rightX =
        math.max(
            1,
            math.min(
                MAP_SCREEN_WIDTH,
                rightX
            )
        )


    topY =
        math.max(
            1,
            math.min(
                MAP_SCREEN_HEIGHT,
                topY
            )
        )


    bottomY =
        math.max(
            1,
            math.min(
                MAP_SCREEN_HEIGHT,
                bottomY
            )
        )


    -- Top + bottom
    for x =
        math.min(
            leftX,
            rightX
        ),
        math.max(
            leftX,
            rightX
        )
    do

        drawGlobalPixel(
            x,
            topY,
            colors.white
        )


        drawGlobalPixel(
            x,
            bottomY,
            colors.white
        )
    end


    -- Left + right
    for y =
        math.min(
            topY,
            bottomY
        ),
        math.max(
            topY,
            bottomY
        )
    do

        drawGlobalPixel(
            leftX,
            y,
            colors.white
        )


        drawGlobalPixel(
            rightX,
            y,
            colors.white
        )
    end
end


-- =========================================================
-- DRAW RANGE RINGS
-- =========================================================

local function drawRangeRings()

    local centerX,
        centerY =
        worldToMap(
            MAP_CENTER_X,
            MAP_CENTER_Z
        )


    local mapWorldWidth =
        MAP_X2 - MAP_X1

    local mapWorldHeight =
        MAP_Z2 - MAP_Z1


    for _, radius
        in ipairs(RANGE_RADII)
    do

        local rx =
            radius
            / mapWorldWidth
            * (MAP_SCREEN_WIDTH - 1)


        local ry =
            radius
            / mapWorldHeight
            * (MAP_SCREEN_HEIGHT - 1)


        for angle = 0, 359 do

            local radians =
                math.rad(angle)


            local x =
                math.floor(
                    centerX
                    + math.cos(radians)
                    * rx
                    + 0.5
                )


            local y =
                math.floor(
                    centerY
                    + math.sin(radians)
                    * ry
                    + 0.5
                )


            drawGlobalPixel(
                x,
                y,
                colors.gray
            )
        end
    end
end


-- =========================================================
-- NUMBER -> LETTER
-- =========================================================

local function numberToLetter(
    number
)

    local result = ""


    while number > 0 do

        local remainder =
            (number - 1)
            % 26


        result =
            string.char(
                string.byte("A")
                + remainder
            )
            .. result


        number =
            math.floor(
                (number - 1)
                / 26
            )
    end


    return result
end


-- =========================================================
-- BUILD MAP GROUPS
-- =========================================================
--
-- Same cell:
--
--   1
--
-- Adjacent:
--
--   1 2
--
-- Diagonal:
--
--   1 .
--   . 2
--
-- Connected:
--
--   1 2 3
--
-- All of these become a single group.
-- =========================================================

local function buildMapGroups(
    players
)

    local positions = {}
    local groups = {}
    local groupedPlayers = {}


    -- =====================================================
    -- Calculate map position for every player
    -- =====================================================

    for playerIndex, player
        in ipairs(players)
    do

        local drawX =
            math.max(
                MAP_X1,
                math.min(
                    MAP_X2,
                    player.x
                )
            )


        local drawZ =
            math.max(
                MAP_Z1,
                math.min(
                    MAP_Z2,
                    player.z
                )
            )


        local screenX,
            screenY =
            worldToMap(
                drawX,
                drawZ
            )


        if screenX
            and screenY
        then

            positions[
                #positions + 1
            ] = {

                playerIndex =
                    playerIndex,

                x = screenX,
                y = screenY,

                visited = false
            }
        end
    end


    -- =====================================================
    -- Find connected groups
    -- =====================================================

    for i = 1, #positions do

        local start =
            positions[i]


        if not start.visited then

            local queue = {
                i
            }


            local queuePosition =
                1


            start.visited =
                true


            local groupPlayers = {}


            while queuePosition
                <= #queue
            do

                local currentIndex =
                    queue[
                        queuePosition
                    ]


                queuePosition =
                    queuePosition + 1


                local current =
                    positions[
                        currentIndex
                    ]


                groupPlayers[
                    #groupPlayers + 1
                ] =
                    current.playerIndex


                -- =========================================
                -- Check all surrounding players
                -- =========================================

                for j = 1, #positions do

                    local other =
                        positions[j]


                    if not other.visited then

                        local dx =
                            math.abs(
                                other.x
                                - current.x
                            )


                        local dy =
                            math.abs(
                                other.y
                                - current.y
                            )


                        -- Same or adjacent cell
                        if dx <= 1
                            and dy <= 1
                        then

                            other.visited =
                                true


                            queue[
                                #queue + 1
                            ] =
                                j
                        end
                    end
                end
            end


            -- =================================================
            -- Only create a group if there are 2+ players
            -- =================================================

            if #groupPlayers >= 2 then

                local firstPlayer =
                    players[
                        groupPlayers[1]
                    ]


                local drawX =
                    math.max(
                        MAP_X1,
                        math.min(
                            MAP_X2,
                            firstPlayer.x
                        )
                    )


                local drawZ =
                    math.max(
                        MAP_Z1,
                        math.min(
                            MAP_Z2,
                            firstPlayer.z
                        )
                    )


                local groupX,
                    groupY =
                    worldToMap(
                        drawX,
                        drawZ
                    )


                local group = {

                    x = groupX,

                    y = groupY,

                    players =
                        groupPlayers
                }


                groups[
                    #groups + 1
                ] =
                    group


                -- =================================================
                -- Mark EVERY player in the group.
                --
                -- This prevents ANY of their numbers from
                -- appearing individually on the map.
                -- =================================================

                for _, playerIndex
                    in ipairs(
                        groupPlayers
                    )
                do

                    groupedPlayers[
                        playerIndex
                    ] = true
                end
            end
        end
    end


    -- =====================================================
    -- Stable ordering
    -- =====================================================

    table.sort(
        groups,
        function(a, b)

            if a.y ~= b.y then
                return a.y < b.y
            end

            return a.x < b.x
        end
    )


    -- =====================================================
    -- Assign group letters
    -- =====================================================

    for i, group
        in ipairs(groups)
    do

        group.letter =
            numberToLetter(i)
    end


    return groups,
        groupedPlayers
end


-- =========================================================
-- GROUP COLOR
-- =========================================================

local function getGroupColor(
    group,
    players
)

    local firstStatus

    local hasFirstStatus =
        false

    local mixed =
        false


    for _, playerIndex
        in ipairs(
            group.players
        )
    do

        local player =
            players[playerIndex]


        if player then

            local status =
                player.status


            if not hasFirstStatus then

                firstStatus =
                    status

                hasFirstStatus =
                    true

            elseif status
                ~= firstStatus
            then

                mixed = true

                break
            end
        end
    end


    -- Different statuses = orange
    if mixed then
        return colors.orange
    end


    return getPlayerColor(
        firstStatus
    )
end


-- =========================================================
-- GROUP MONITOR WRITE
-- =========================================================

local function safeGroupWrite(
    x,
    y,
    text,
    color
)

    local width,
        height =
        groupMonitor.getSize()


    if y < 1
        or y > height
    then

        return
    end


    if x < 1
        or x > width
    then

        return
    end


    groupMonitor.setCursorPos(
        x,
        y
    )


    groupMonitor.setBackgroundColor(
        colors.black
    )


    groupMonitor.setTextColor(
        color or colors.white
    )


    groupMonitor.write(
        tostring(text):sub(
            1,
            width - x + 1
        )
    )
end


-- =========================================================
-- DRAW GROUP LIST
-- =========================================================

local function drawGroupList(
    groups,
    players
)

    local width,
        height =
        groupMonitor.getSize()


    groupMonitor.setBackgroundColor(
        colors.black
    )


    groupMonitor.clear()


    -- =====================================================
    -- Header
    -- =====================================================

    safeGroupWrite(
        1,
        1,
        "GROUPS",
        colors.white
    )


    -- =====================================================
    -- Separator
    -- =====================================================

    if height >= 2 then

        safeGroupWrite(
            1,
            2,
            string.rep(
                "-",
                width
            ),
            colors.gray
        )
    end


    local line = 3


    for groupIndex,
        group
        in ipairs(groups)
    do

        if line > height then
            break
        end


        local groupColor =
            getGroupColor(
                group,
                players
            )


        -- =================================================
        -- Group letter
        -- =================================================

        safeGroupWrite(
            1,
            line,
            group.letter .. ":",
            groupColor
        )


        -- Start after "A:"
        local x = 3


        -- =================================================
        -- Player numbers
        -- =================================================

        for _, playerIndex
            in ipairs(
                group.players
            )
        do

            local player =
                players[playerIndex]


            if player then

                local numberText =
                    tostring(
                        playerIndex
                    )


                safeGroupWrite(
                    x,
                    line,
                    numberText,
                    groupColor
                )


                x =
                    x
                    + #numberText
                    + 1


                if x > width then
                    break
                end
            end
        end


        -- =================================================
        -- Separator between groups
        -- =================================================

        if groupIndex < #groups then

            line =
                line + 1


            if line > height then
                break
            end


            safeGroupWrite(
                1,
                line,
                string.rep(
                    "-",
                    width
                ),
                colors.gray
            )
        end


        line =
            line + 1
    end


    if #groups == 0 then

        safeGroupWrite(
            1,
            3,
            "None",
            colors.gray
        )
    end


    groupMonitor.setTextColor(
        colors.white
    )
end


-- =========================================================
-- DRAW SINGLE PLAYER
-- =========================================================

local function drawPlayer(
    player,
    playerIndex,
    groupedPlayers
)

    -- =====================================================
    -- IMPORTANT:
    --
    -- A grouped player gets NO individual number.
    -- =====================================================

    if groupedPlayers[
        playerIndex
    ] then

        return
    end


    -- =====================================================
    -- Clamp player to map
    -- =====================================================

    local drawX =
        math.max(
            MAP_X1,
            math.min(
                MAP_X2,
                player.x
            )
        )


    local drawZ =
        math.max(
            MAP_Z1,
            math.min(
                MAP_Z2,
                player.z
            )
        )


    local screenX,
        screenY =
        worldToMap(
            drawX,
            drawZ
        )


    if not screenX
        or not screenY
    then

        return
    end


    local color =
        getPlayerColor(
            player.status
        )


    local numberText =
        tostring(
            playerIndex
        )


    safeGlobalWrite(
        screenX,
        screenY,
        numberText,
        color
    )
end


-- =========================================================
-- DRAW GROUP ON MAP
-- =========================================================

local function drawGroupOnMap(
    group,
    players
)

    local color =
        getGroupColor(
            group,
            players
        )


    safeGlobalWrite(
        group.x,
        group.y,
        group.letter,
        color
    )
end


-- =========================================================
-- CLEAR MAP MONITORS
-- =========================================================

local function clearMapMonitors()

    local mapMonitors = {

        topLeft,

        topRight,

        bottomLeft,

        bottomRight
    }


    for _, monitor
        in ipairs(mapMonitors)
    do

        monitor.setBackgroundColor(
            colors.black
        )


        monitor.setTextColor(
            colors.white
        )


        monitor.clear()
    end
end


-- =========================================================
-- DRAW MAP
-- =========================================================

local function drawMap(
    players
)

    -- =====================================================
    -- Re-apply map text scale
    -- =====================================================

    topRight.setTextScale(
        MAP_MONITOR_SCALE
    )

    topLeft.setTextScale(
        MAP_MONITOR_SCALE
    )

    bottomRight.setTextScale(
        MAP_MONITOR_SCALE
    )

    bottomLeft.setTextScale(
        MAP_MONITOR_SCALE
    )


    -- =====================================================
    -- Clear map
    -- =====================================================

    clearMapMonitors()


    -- =====================================================
    -- Draw overlays
    -- =====================================================

    drawRangeRings()

    drawMapSquare()


    -- =====================================================
    -- Build groups
    -- =====================================================

    local groups,
        groupedPlayers =
        buildMapGroups(
            players
        )


    -- =====================================================
    -- Draw individual players
    --
    -- Every grouped player is skipped.
    -- =====================================================

    for playerIndex,
        player
        in ipairs(players)
    do

        drawPlayer(
            player,
            playerIndex,
            groupedPlayers
        )
    end


    -- =====================================================
    -- Draw groups
    -- =====================================================

    for _, group
        in ipairs(groups)
    do

        drawGroupOnMap(
            group,
            players
        )
    end


    -- =====================================================
    -- Draw group monitor
    -- =====================================================

    drawGroupList(
        groups,
        players
    )
end


-- =========================================================
-- TERMINAL DISPLAY
-- =========================================================

local function displayTerminal(
    senderID,
    players,
    timestamp
)

    term.setBackgroundColor(
        colors.black
    )


    term.setTextColor(
        colors.white
    )


    term.clear()


    term.setCursorPos(
        1,
        1
    )


    print(
        "========================================"
    )


    print(
        "             RADAR RECEIVER             "
    )


    print(
        "========================================"
    )


    print(
        "Computer ID: "
        .. os.getComputerID()
    )


    print(
        "Modem:       "
        .. REDNET_SIDE
    )


    print(
        "Protocol:    "
        .. PROTOCOL
    )


    print(
        "Map:         2x2 monitors"
    )


    print(
        "Map scale:   "
        .. tostring(
            MAP_MONITOR_SCALE
        )
    )


    print(
        "Map size:    "
        .. (
            MAP_X2 - MAP_X1
        )
        .. "x"
        .. (
            MAP_Z2 - MAP_Z1
        )
        .. " blocks"
    )


    print("")


    print(
        "MAP MONITORS"
    )


    print(
        "26 = TOP LEFT"
    )


    print(
        "25 = TOP RIGHT"
    )


    print(
        "28 = BOTTOM LEFT"
    )


    print(
        "27 = BOTTOM RIGHT"
    )


    print("")


    print(
        "GROUP MONITOR:"
    )


    print(
        "  "
        .. groupMonitorName
    )


    if timestamp then

        print(
            "Timestamp:   "
            .. tostring(
                timestamp
            )
        )
    end


    print(
        "----------------------------------------"
    )


    print(
        "Players received: "
        .. tostring(
            #players
        )
    )


    print(
        "----------------------------------------"
    )


    if #players == 0 then

        print(
            "No players detected."
        )

    else

        for i, player
            in ipairs(players)
        do

            local status =
                player.status
                or "unknown"


            print(
                tostring(i)
                .. ". "
                .. player.username
                .. " ["
                .. tostring(status)
                .. "]"
            )


            print(
                "   X: "
                .. string.format(
                    "%.2f",
                    player.x
                )
                .. "  Y: "
                .. string.format(
                    "%.2f",
                    player.y
                )
                .. "  Z: "
                .. string.format(
                    "%.2f",
                    player.z
                )
            )
        end
    end


    print(
        "----------------------------------------"
    )


    print(
        "Waiting for radar update..."
    )
end


-- =========================================================
-- STARTUP
-- =========================================================

term.clear()

term.setCursorPos(
    1,
    1
)


print(
    "========================================"
)

print(
    "          RADAR MAP DISPLAY             "
)

print(
    "========================================"
)


print(
    "Computer ID: "
    .. os.getComputerID()
)


print(
    "Modem:       "
    .. REDNET_SIDE
)


print(
    "Protocol:    "
    .. PROTOCOL
)


print(
    "Map scale:   "
    .. tostring(
        MAP_MONITOR_SCALE
    )
)


print("")


print(
    "MAP MONITORS"
)


print(
    "26 = TOP LEFT"
)


print(
    "25 = TOP RIGHT"
)


print(
    "28 = BOTTOM LEFT"
)


print(
    "27 = BOTTOM RIGHT"
)


print("")


print(
    "GROUP MONITOR:"
)


print(
    "  "
    .. groupMonitorName
)


print("")


print(
    "Virtual map: "
    .. MAP_SCREEN_WIDTH
    .. "x"
    .. MAP_SCREEN_HEIGHT
    .. " pixels"
)


print(
    "World map:   "
    .. (
        MAP_X2 - MAP_X1
    )
    .. "x"
    .. (
        MAP_Z2 - MAP_Z1
    )
    .. " blocks"
)


print("")


print(
    "Waiting for radar data..."
)


-- =========================================================
-- MAIN LOOP
-- =========================================================

local lastPlayers = {}


drawMap(
    lastPlayers
)


while true do

    local senderID,
        message,
        protocol =
        rednet.receive(
            PROTOCOL
        )


    if protocol == PROTOCOL then

        if type(message) == "table"
            and type(message.data) == "table"
        then

            local players =
                buildPlayerList(
                    message.data
                )


            lastPlayers =
                players


            -- =================================================
            -- Update monitors
            -- =================================================

            drawMap(
                players
            )


            -- =================================================
            -- Update terminal
            -- =================================================

            displayTerminal(
                senderID,
                players,
                message.timestamp
            )
        end
    end
end
