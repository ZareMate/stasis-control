# Stasis Control

Web dashboard for controlling Minecraft ender-pearl stasis chambers through ComputerCraft WebSockets.

## Architecture

There is **no chamber/base configuration file**.

The server learns everything from connected ComputerCraft controllers:

- Base number and base name
- Chamber numbers and labels
- Player names
- Chamber status
- Which controller reported each chamber

Multiple controllers can report chambers for the same base. The server combines their reports and counts each chamber only once.

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

## Controller registration

After opening the WebSocket, a ComputerCraft controller sends:

```json
{
  "type": "register",
  "controller": "base-1",
  "base": 1,
  "baseName": "Base 1"
}
```

This registration is sent through WebSocket; it is not stored in server configuration.

## Chamber status

Controllers send:

```json
{
  "type": "status",
  "chamber": 1,
  "label": "Chamber 01",
  "player": "PlayerName",
  "status": "ready"
}
```

Supported statuses:

- `empty`
- `ready`
- `pulling`
- `pulled`

The server also accepts:

```json
{
  "type": "stasis",
  "chambers": [
    {
      "chamber": 1,
      "label": "Chamber 01",
      "player": "PlayerName",
      "status": "ready"
    }
  ]
}
```

## Dynamic player count

The dashboard player count is calculated from the chamber reports currently held by connected ComputerCraft controllers.

A chamber counts as one player when it has a reported player and status:

- `ready`
- `pulling`
- `pulled`

If multiple controllers report the same chamber, it is counted only once.

If controllers for the same base report different chambers, all of those chambers are combined.

## Pulling

The browser sends:

```json
{
  "base": 1,
  "chamber": 1
}
```

The server routes the pull to the controller that most recently reported that chamber. If that controller is unavailable, another controller for the same base is used.

A `pulled` chamber remains visible as pulled for 5 seconds and then returns to `ready`.

## Security

Do not commit the real controller token.

Set `STASIS_TOKEN` on the server and use the same value in ComputerCraft. Browser clients do not receive the controller token.

For public deployment, use HTTPS and an authentication layer before exposing pull controls.
## ComputerCraft monitor and heartbeat

The included controller automatically uses the first connected ComputerCraft monitor peripheral (`peripheral.find("monitor")`).

The monitor shows the controller/base, WebSocket connection state, heartbeat state, chamber totals, and each configured chamber's player and status.

The controller sends a WebSocket heartbeat every 10 seconds and expects an acknowledgement within 5 seconds. A missed acknowledgement causes the controller to close the WebSocket and reconnect.

Heartbeat request:

```json
{
  "type": "heartbeat",
  "id": 1
}
```

Heartbeat response:

```json
{
  "type": "heartbeat-ack",
  "id": 1
}
```