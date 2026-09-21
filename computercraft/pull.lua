local args = { ... }

local SERVER_URL = "http://127.0.0.1:3000"
local STASIS_TOKEN = "replace-with-your-stasis-token"

local function usage()
    print("Usage:")
    print("  pull <player>")
    print("  pull <base> <player>")
    print("  chambers")
    print("  chambers <base>")
    print("  chambers player <player>")
end

local function request(path)
    local ok, response = pcall(http.get, SERVER_URL .. path, {
        ["X-Stasis-Token"] = STASIS_TOKEN
    })

    if not ok then
        printError("HTTP request failed: " .. tostring(response))
        return nil
    end

    if not response then
        print("Server rejected the request or HTTP access is disabled.")
        return nil
    end

    local status = response.getResponseCode()
    local body = response.readAll()
    response.close()

    return status, textutils.unserializeJSON(body)
end

if args[1] == "chambers" then
    local query = ""

    if #args == 2 then
        local base = tonumber(args[2])

        if not base then
            print("Usage: chambers <base>")
            return
        end

        query = "?base=" .. textutils.urlEncode(tostring(base))
    elseif #args == 3 and args[2] == "player" then
        query = "?player=" .. textutils.urlEncode(args[3])
    elseif #args ~= 1 then
        usage()
        return
    end

    local status, decoded = request("/api/computer/chambers" .. query)

    if not status then
        return
    end

    if status < 200 or status >= 300 then
        print("Chamber request failed (" .. tostring(status) .. ")")

        if decoded and decoded.error then
            print(decoded.error)
        end

        return
    end

    print("Chambers: " .. tostring(decoded and decoded.count or 0))

    for _, chamber in ipairs((decoded and decoded.chambers) or {}) do
        print(
            "Base " .. tostring(chamber.base) ..
            " / Chamber " .. tostring(chamber.chamber) ..
            " | " .. tostring(chamber.player ~= "" and chamber.player or "EMPTY") ..
            " | " .. tostring(chamber.status) ..
            " | " .. tostring(chamber.label)
        )
    end

    return
end

if #args < 1 or #args > 2 then
    usage()
    return
end

local base
local player

if #args == 1 then
    player = args[1]
else
    base = tonumber(args[1])
    player = args[2]

    if not base then
        print("Invalid base: " .. tostring(args[1]))
        return
    end
end

local bodyTable = {
    player = player
}

if base then
    bodyTable.base = base
end

local body = textutils.serializeJSON(bodyTable)

local ok, response = pcall(http.post, SERVER_URL .. "/api/computer/pull", body, {
    ["Content-Type"] = "application/json",
    ["X-Stasis-Token"] = STASIS_TOKEN
})

if not ok then
    printError("HTTP request failed: " .. tostring(response))
    return
end

if not response then
    print("Server rejected the request or HTTP access is disabled.")
    return
end

local status = response.getResponseCode()
local responseBody = response.readAll()
response.close()

local decoded = textutils.unserializeJSON(responseBody)

if status >= 200 and status < 300 then
    print("Pull sent")
    print("Player: " .. tostring(decoded and decoded.player or player))
    print("Base: " .. tostring(decoded and decoded.base or "?"))
    print("Chamber: " .. tostring(decoded and decoded.chamber or "?"))
    return
end

print("Pull failed (" .. tostring(status) .. ")")

if decoded and decoded.error then
    print(decoded.error)
end

if decoded and decoded.availableBases then
    print("Available bases: " .. table.concat(decoded.availableBases, ", "))
end
