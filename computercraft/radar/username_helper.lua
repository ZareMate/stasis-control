-- =========================================================
-- RADAR USERNAME HELPER
-- UUID -> Minecraft username resolution with local caching.
-- =========================================================

local cache = {}

local function usernameFromUUID(uuid)
    if type(uuid) ~= "string" or uuid == "" or not http then
        return nil
    end

    if cache[uuid] ~= nil then
        return cache[uuid] or nil
    end

    local ok, username = pcall(function()
        local response = http.get(
            "https://playerdb.co/api/player/minecraft/" .. uuid
        )

        if not response then
            return nil
        end

        local body = response.readAll()
        response.close()

        local parsedOk, data = pcall(textutils.unserialiseJSON, body)
        if not parsedOk or type(data) ~= "table" then
            return nil
        end

        local player = data.data and data.data.player
        local result = player and player.username

        if type(result) == "string" and result ~= "" then
            return result
        end

        return nil
    end)

    if ok and type(username) == "string" and username ~= "" then
        cache[uuid] = username
        return username
    end

    cache[uuid] = false
    return nil
end

return {
    usernameFromUUID = usernameFromUUID
}
