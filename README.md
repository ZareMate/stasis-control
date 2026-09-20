# Stasis Control

Web dashboard for controlling Minecraft ender-pearl stasis chambers through ComputerCraft.

## Features

- Modern dark dashboard
- 3 bases
- 20 stasis chambers
- Player/chamber configuration
- One-click PULL PEARL
- Browser -> Node.js -> ComputerCraft WebSocket communication
- Live chamber status
- Activity log
- Browser never sends raw redstone commands

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

Copy `computercraft/stasis.lua` to a ComputerCraft computer with the HTTP API enabled. Set the server URL, token and controller name in the file. Run one controller per base.

The exact redstone/Create wiring is intentionally a placeholder until the chamber wiring is known.

## Protocol

Pull request:

```json
{"type":"pull","chamber":1,"player":"PlayerName","requestId":"uuid"}
```

Status update:

```json
{"type":"status","chamber":1,"player":"PlayerName","status":"ready"}
```

Supported statuses: `empty`, `ready`, `pulling`, `pulled`.

## Security

Do not commit the real controller token. Set `STASIS_TOKEN` on the server and use the same value in ComputerCraft. For public deployment, use HTTPS and an authentication layer before exposing pull controls.
