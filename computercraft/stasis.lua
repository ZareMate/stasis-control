-- Stasis Control multishell launcher
-- Starts the controller as three independent ComputerCraft shells:
--   Boot    - WebSocket connection, heartbeat and event routing
--   Radar   - Create Radar scanning and readiness state
--   Pulling - relay/pull execution

local PROGRAM_DIR = fs.getDir(shell.getRunningProgram())

local BOOT = fs.combine(PROGRAM_DIR, "stasis-boot.lua")
local RADAR = fs.combine(PROGRAM_DIR, "stasis-radar.lua")
local PULLING = fs.combine(PROGRAM_DIR, "stasis-pulling.lua")

if not multishell or not multishell.launch then
    error("This controller requires an Advanced Computer with multishell support.")
end

for _, file in ipairs({ BOOT, RADAR, PULLING }) do
    if not fs.exists(file) then
        error("Missing controller component: " .. file)
    end
end

local bootTab = multishell.launch({}, BOOT)
local radarTab = multishell.launch({}, RADAR)
local pullingTab = multishell.launch({}, PULLING)

multishell.setTitle(bootTab, "Boot")
multishell.setTitle(radarTab, "Radar")
multishell.setTitle(pullingTab, "Pulling")

print("Stasis Control started.")
print("Boot tab:     " .. tostring(bootTab))
print("Radar tab:    " .. tostring(radarTab))
print("Pulling tab:  " .. tostring(pullingTab))
