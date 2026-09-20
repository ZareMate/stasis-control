# Stasis Control

Web dashboard for controlling Minecraft ender-pearl stasis chambers through ComputerCraft.

## Features

- Modern dark dashboard
- 3 bases
- 20 stasis chambers
- One controller per base
- Player/chamber configuration
- One-click PULL PEARL
- Browser -> Node.js -> ComputerCraft WebSocket communication
- Live chamber status
- Live activity log
- ComputerCraft remains the hardware controller
- Controller/base routing so a pull only reaches the correct base
- Controller disconnects mark its chambers offline
- Initial ComputerCraft status announcements
- Supports single-chamber status messages and multi-chamber stasis snapshots

## Install

Requires Node.js 18+.

```bash
git clone https://github.com/ZareMate/stasis-control.git
cd stasis-control
npm install
export STASIS_TOKEN="replace-with-a-long-random-token"
npm start
```

Dashboard: `http://YOUR_SERVER_IP:3000`

## Chamber layout

- Base 1: chambers 1-7
- Base 2: chambers 8-14
- Base 3: chambers 15-20

Edit `config/chambers.json` to assign players.

## ComputerCraft

Copy `computercraft/stasis.lua` to one ComputerCraft computer per base.

Set:

```lua
local SERVER = "ws://YOUR_SERVER_IP:3000/ws"
local TOKEN = "YOUR_STASIS_TOKEN"
local CONTROLLER_NAME = "base-1"
local BASE_ID = 1
```

For the second and third bases, use:

```lua
local CONTROLLER_NAME = "base-2"
local BASE_ID = 2
```

and:

```lua
local CONTROLLER_NAME = "base-3"
local BASE_ID = 3
```

Configure each relay:

```lua
local RELAYS = {
    { chamber = 1, player = "Piotrusek69", relay = "redstone_relay_1" },
    { chamber = 2, player = "Toprak", relay = "redstone_relay_2" }
}
```

The controller announces its ready chambers when it connects.

## WebSocket protocol

### Pull

The server sends a pull only to the controller that owns the chamber's base:

```json
{
  "type": "pull",
  "base": 1,
  "chamber": 1,
  "player": "PlayerName",
  "requestId": "uuid"
}
```

### Status

ComputerCraft can report individual chambers:

```json
{
  "type": "status",
  "chamber": 1,
  "player": "PlayerName",
  "status": "ready"
}
```

Supported statuses:

- `empty`
- `ready`
- `pulling`
- `pulled`

The server also accepts a multi-chamber snapshot:

```json
{
  "type": "stasis",
  "chambers": [
    { "chamber": 1, "player": "PlayerName", "status": "ready" },
    { "chamber": 2, "player": "OtherPlayer", "status": "empty" }
  ]
}
```

For a status message without a chamber number, the server can resolve the chamber by player name within that controller's base.

### Pull result

ComputerCraft should send:

```json
{
  "type": "pull-result",
  "chamber": 1,
  "player": "PlayerName",
  "requestId": "uuid",
  "success": true
}
```

## Security

Do not commit the real controller token.

Set `STASIS_TOKEN` on the server and use the same value in ComputerCraft. The browser does not receive the controller token.

For public deployment, put the dashboard behind HTTPS and an authentication layer before exposing pull controls.
