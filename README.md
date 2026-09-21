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

Speech recognition uses local `whisper.cpp`. The Node bot invokes the `whisper-cli` executable, so the bot does not depend on the old Vosk Node FFI addon.

Set up Whisper:

```bash
npm install
npm run stt:setup
```

The setup script clones `whisper.cpp`, builds `whisper-cli`, and downloads the `small.en` model by default. The English-only `small.en` model is substantially larger than `tiny.en` and is intended for higher recognition accuracy; current whisper.cpp documentation lists about 466 MiB on disk and about 852 MB of memory for `small`, versus about 75 MiB and 273 MB for `tiny`. citeturn146732search0turn146732search2 The official whisper.cpp documentation shows the same build flow and its `download-ggml-model.sh` model downloader. citeturn754375search1turn754375search0

The bot then listens for:

```text
Farex pull my pearl
```

and triggers the existing pull API for `Farex`, using the saved default base.

Change the trigger with:

```env
VOICE_TRIGGER=Farex pull my pearl
VOICE_TRIGGER_PLAYER=Farex
WHISPER_CLI_PATH=./whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=./models/ggml-small.en.bin
WHISPER_THREADS=4
WHISPER_BEAM_SIZE=10
WHISPER_BEST_OF=10
WHISPER_PROMPT=Farex. Pull my pearl. Ender pearl. Stasis chamber. Minecraft.
```

The `whisper-cli` tool accepts 16-bit WAV input; the bot converts Discord's decoded PCM stream into a temporary 16-bit, 16 kHz mono WAV file before transcription. The bot also uses beam search/best-of settings and an initial prompt containing the trigger vocabulary; current whisper.cpp CLI documentation exposes `--beam-size`, `--best-of`, and `--prompt`. citeturn788385search0turn146732search4 citeturn754375search1turn754375search3

`/leave` disconnects the bot and stops voice recognition. Trigger matching is tolerant of common Whisper variations such as splitting `Farex` into multiple words, while still requiring the `pull` and `pearl` parts of the command.
