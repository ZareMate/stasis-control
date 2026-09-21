local args = { ... }

local SERVER_URL = "http://127.0.0.1:3000"
local STASIS_TOKEN = "replace-with-your-stasis-token"

local function usage()
    print("Usage:")
    print("  pull <player>")
    print("  pull <base> <player>")
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
