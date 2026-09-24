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

## Dashboard Discord login

Create a Discord application and add the exact callback URL `https://YOUR_DOMAIN/auth/discord/callback` to its OAuth2 redirect URLs. Configure:

```env
DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_CLIENT_SECRET=your-discord-client-secret
DISCORD_REDIRECT_URI=https://YOUR_DOMAIN/auth/discord/callback
```

The dashboard requests Discord's `identify` and `email` scopes. Discord returns the email through `/users/@me` when available and authorized; the dashboard keeps it in the in-memory session and includes it in new dashboard pull activity entries. Pull and player configuration actions require a signed-in dashboard session; the server checks this independently of the disabled UI controls. Sessions are held in memory for seven days and are cleared when the server restarts. Dashboard pull activity records the Discord username, email, and ID alongside the Minecraft player and chamber. Bot pulls include the invoking Discord user in the activity log. The latest 50 activity entries are persisted in `data/activity-logs.json` (or under `STASIS_DATA_DIR`).

The `/logs` page and `/api/logs` endpoint require a dashboard Discord session. The page supports filtering by activity type and requesting user.

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

## Player default bases

The dashboard has a **CONFIG** menu where a player can enter their Minecraft name and choose a connected base as their default.

The setting is stored server-side in `data/player-preferences.json` and is used by the Discord `/pull player` command when the player exists at more than one base.

The browser also remembers the last entered Minecraft player name locally so the configuration form is easier to reuse.

## Discord bot

The repository includes a Discord bot in `bot/index.js`.

Install dependencies:

```bash
npm install
```

Configure these environment variables:

```env
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_GUILD_ID=your-discord-server-id
STASIS_API_URL=http://127.0.0.1:3000
PULL_API_TOKEN=replace-with-a-separate-pull-api-token
```

Start the bot:

```bash
npm run bot
```

The bot registers:

```text
/pull player
```

The player field has autocomplete from the currently reported stasis players.

Pull resolution works like this:

1. If the player has a saved default base, that base is used.
2. If the player only exists at one base, that base is used automatically.
3. If the player exists at multiple bases without a default, the command returns the available bases and asks for a default to be configured on the dashboard.

`PULL_API_TOKEN` is separate from the ComputerCraft `STASIS_TOKEN`.
## Discord voice command

The Discord bot supports `/join` and `/leave`.

`/join` makes the bot join the voice channel of the user who issued the command. It listens only to that user's audio.

Speech recognition uses local `whisper.cpp`. The bot starts a persistent `whisper-server` process when it starts and keeps the model loaded until the bot shuts down. Each voice clip is then sent to that already-running server instead of starting a new Whisper process.

Set up Whisper:

```bash
npm install
npm run stt:setup
```

The setup script clones `whisper.cpp`, builds `whisper-cli`, and downloads the configured Whisper model.

The bot listens for a single voice trigger word:

```text
home
```

When the trigger is detected, it calls the existing pull API for the player configured by `VOICE_TRIGGER_PLAYER`, using the saved default base.

Configure the trigger with:

```env
VOICE_TRIGGER=home
VOICE_TRIGGER_PLAYER=Farex
VOICE_SILENCE_MS=450
WHISPER_SERVER_PATH=./whisper.cpp/build/bin/whisper-server
WHISPER_SERVER_PORT=39781
WHISPER_MODEL_PATH=./models/ggml-large-v3-turbo.bin
WHISPER_THREADS=4
```

The single-word trigger also tolerates small Whisper transcription errors. Voice input is finalized after a short silence window (450 ms by default), and Whisper decoding uses a single best candidate with fallback disabled to reduce latency.

The Whisper server accepts WAV files through its `/inference` HTTP endpoint. The bot converts Discord's decoded PCM stream into a temporary 16-bit, 16 kHz mono WAV file and sends it to the persistent server. citeturn957550search1turn426544view0

`/leave` disconnects the bot and stops voice recognition.

## ComputerCraft pull API

Computers can request a pearl pull over HTTP using:

```text
POST /api/computer/pull
```

Authenticate with the same `STASIS_TOKEN` used by ComputerCraft controllers, using either `X-Stasis-Token` or `Authorization: Bearer ...`.

The request can specify both player and base:

```json
{
  "player": "PlayerName",
  "base": 1
}
```

Or just the player:

```json
{
  "player": "PlayerName"
}
```

When no base is supplied, the server uses that player's configured default base. If there is no default and the player is reported at multiple bases, the response contains `availableBases` and no pull is performed.

A ready-to-use ComputerCraft program is included at `computercraft/pull.lua`:

```text
pull <player>
pull <base> <player>
```

Set `SERVER_URL` and `STASIS_TOKEN` at the top of the program before using it.

## ComputerCraft chamber API

Computers can also read the currently reported chambers with:

```text
GET /api/computer/chambers
```

The request uses the ComputerCraft `STASIS_TOKEN` in `X-Stasis-Token`.

Optional filters:

```text
/api/computer/chambers?base=1
/api/computer/chambers?player=PlayerName
```

For a player request without a base, the configured default base is preferred when one exists. The response contains the chamber number, base, player, status, label, controller, and default-base information.

The included `computercraft/pull.lua` utility can query chambers with:

```text
chambers
chambers <base>
chambers player <player>
```

## ComputerCraft multishell controller

The ComputerCraft controller is split into three independent processes:

- `computercraft/stasis.lua` is the launcher and opens three multishell tabs.
- `computercraft/stasis-boot.lua` owns the WebSocket connection, heartbeat, reconnects, and routes server commands/status updates.
- `computercraft/stasis-radar.lua` continuously reads the Create Radar peripheral and controls chamber readiness.
- `computercraft/stasis-pulling.lua` handles pull requests and redstone relay pulses independently from Radar.

Radar and pulling therefore continue running in parallel. A relay pulse does not pause Radar scanning.

Copy all four files into the same ComputerCraft directory and configure `SERVER`, `TOKEN`, `CONTROLLER_NAME`, and `BASE_ID` in `stasis-boot.lua`, plus the chamber/player/relay configuration in `stasis-radar.lua` and `stasis-pulling.lua`.

Run:

```text
stasis.lua
```

The Radar process uses `entity.minecraft.ender_pearl` and the configured chamber block ranges. After a successful pull, the Radar process keeps the chamber in `pulled` for `PULLED_DISPLAY_TIME`; after that it resumes live Radar detection and reports `ready` or `empty` based on the pearl's presence.
