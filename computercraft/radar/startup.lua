-- =========================================================
-- RADAR MULTISHELL LAUNCHER
-- =========================================================
if not multishell then
    error("This program requires CC:Tweaked multishell.")
end

pcall(fs.delete, "radar_stop")

local tabs = {
    {path = "radar.lua", title = "RADAR"},
    {path = "gui.lua", title = "GUI"},
    {path = "redstone.lua", title = "REDSTONE"},
}

for _, app in ipairs(tabs) do
    if not fs.exists(app.path) then
        error("Missing " .. app.path)
    end
end

local ids = {}
for _, app in ipairs(tabs) do
    local id = shell.openTab(app.path)
    ids[#ids + 1] = id
    multishell.setTitle(id, app.title)
end

-- Show the GUI tab after launching everything.
multishell.setFocus(ids[2])
