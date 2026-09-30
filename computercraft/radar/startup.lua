-- =========================================================
-- RADAR MULTISHELL LAUNCHER
-- =========================================================
-- Keeps exactly one radar service set running.
-- Re-running startup cleanly stops any existing RADAR/GUI/
-- REDSTONE/AIRLOCK tabs before starting a fresh set.

if not multishell then
    error("This program requires CC:Tweaked multishell.")
end

local STOP_FILE = "radar_stop"
local STOP_WAIT_TIMEOUT = 5

local apps = {
    { path = "radar.lua", title = "RADAR" },
    { path = "gui.lua", title = "GUI" },
    { path = "redstone.lua", title = "REDSTONE" },
    { path = "airlock.lua", title = "AIRLOCK" },
}

local managedTitles = {}

for _, app in ipairs(apps) do
    managedTitles[app.title] = true

    if not fs.exists(app.path) then
        error("Missing " .. app.path)
    end
end

local function hasManagedTabs()
    for id = 1, multishell.getCount() do
        if managedTitles[multishell.getTitle(id)] then
            return true
        end
    end

    return false
end

local function requestExistingShutdown()
    local file = fs.open(STOP_FILE, "w")

    if file then
        file.write("restart")
        file.close()
    end
end

-- Stop any existing instance before starting another one.
-- This also cleans up duplicates from older startup runs.
if hasManagedTabs() then
    requestExistingShutdown()

    local deadline = os.clock() + STOP_WAIT_TIMEOUT

    while hasManagedTabs() and os.clock() < deadline do
        sleep(0.1)
    end

    if hasManagedTabs() then
        error(
            "Existing radar tabs did not stop. " ..
            "Press C in the old RADAR/GUI/REDSTONE/AIRLOCK tabs, " ..
            "then run startup again."
        )
    end
end

pcall(fs.delete, STOP_FILE)

local ids = {}

for _, app in ipairs(apps) do
    local id = shell.openTab(app.path)

    ids[#ids + 1] = id
    multishell.setTitle(id, app.title)
end

-- Show the GUI tab after launching everything.
multishell.setFocus(ids[2])
