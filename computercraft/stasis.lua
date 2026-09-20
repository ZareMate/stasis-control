-- Stasis Control ComputerCraft client
local SERVER = "ws://YOUR_SERVER_IP:3000/ws"
local TOKEN = "CHANGE_ME"
local CONTROLLER_NAME = "base-1"
local function enc(v)return textutils.urlEncode(tostring(v))end
local function status(ws,chamber,player,value)ws.send(textutils.serializeJSON({type="status",chamber=chamber,player=player or "",status=value}))end
local function pull(ws,cmd)
 local chamber=tonumber(cmd.chamber);local player=tostring(cmd.player or "Unknown");if not chamber then return end
 print("Pull request: chamber "..chamber.." / "..player);status(ws,chamber,player,"pulling")
 -- Replace this with the actual redstone/Create control for the chamber.
 -- Example: redstone.setOutput("top",true);sleep(0.2);redstone.setOutput("top",false)
 sleep(1);status(ws,chamber,player,"pulled")
end
while true do
 local ws,err=http.websocket(SERVER.."?role=controller&name="..enc(CONTROLLER_NAME).."&token="..enc(TOKEN))
 if not ws then print("Connection failed: "..tostring(err));sleep(5) else
  print("Connected as "..CONTROLLER_NAME)
  while true do
   local event,a,b=os.pullEvent()
   if event=="websocket_message" then local ok,m=pcall(textutils.unserializeJSON,b);if ok and m and m.type=="pull" then pull(ws,m)end
   elseif event=="websocket_closed" then print("Connection closed");break end
  end
  pcall(function()ws.close()end);sleep(2)
 end
end
