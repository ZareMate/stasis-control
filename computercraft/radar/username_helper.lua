-- =========================================================
-- RADAR USERNAME HELPER
-- UUID -> Minecraft username resolution with local caching.
--
-- The synchronous usernameFromUUID() is kept for simple clients.
-- Radar server-side code should use getCached(), queueUUID(), and
-- processQueue() so HTTP requests never block the radar scan.
-- =========================================================

local M = {}

local cache = {}
local pending = {}
local queue = {}

local function normalizeUUID(uuid)
    if type(uuid) ~= "string" or uuid == "" then
        return nil
    end

    return uuid
end

local function lookupUUID(uuid)
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

function M.usernameFromUUID(uuid)
    uuid = normalizeUUID(uuid)

    if not uuid or not http then
        return nil
    end

    if cache[uuid] ~= nil then
        return cache[uuid] or nil
    end

    pending[uuid] = true
    lookupUUID(uuid)
    pending[uuid] = nil

    return cache[uuid] or nil
end

function M.getCached(uuid)
    uuid = normalizeUUID(uuid)

    if not uuid then
        return nil
    end

    if cache[uuid] ~= nil then
        return cache[uuid] or nil
    end

    return nil
end

function M.queueUUID(uuid)
    uuid = normalizeUUID(uuid)

    if not uuid or not http or cache[uuid] ~= nil or pending[uuid] then
        return false
    end

    pending[uuid] = true
    queue[#queue + 1] = uuid
    return true
end

function M.processQueue(concurrency)
    if not http or #queue == 0 then
        return
    end

    concurrency = math.max(1, tonumber(concurrency) or 4)

    local jobs = {}

    for _ = 1, math.min(concurrency, #queue) do
        local uuid = table.remove(queue, 1)

        jobs[#jobs + 1] = function()
            lookupUUID(uuid)
            pending[uuid] = nil
        end
    end

    if #jobs > 0 then
        parallel.waitForAll(table.unpack(jobs))
    end
end

function M.worker(concurrency)
    while not fs.exists("radar_stop") do
        if #queue > 0 then
            M.processQueue(concurrency)
        else
            sleep(0.05)
        end
    end
end

function M.getPendingCount()
    return #queue
end

return M
