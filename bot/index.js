require("dotenv").config();

const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

dns.setDefaultResultOrder("ipv4first");
const { monitorEventLoopDelay } = require("perf_hooks");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags
} = require("discord.js");

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType
} = require("@discordjs/voice");

const prism = require("prism-media");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const STASIS_PORT = process.env.STASIS_PORT || process.env.PORT || "3000";
const STASIS_API_URL = (
  process.env.STASIS_API_URL || "http://127.0.0.1:" + STASIS_PORT
).replace(/\/+$/, "");
const PULL_API_TOKEN =
  process.env.PULL_API_TOKEN || process.env.STASIS_TOKEN;

const WHISPER_CLI_PATH =
  process.env.WHISPER_CLI_PATH ||
  path.join(
    __dirname,
    "..",
    "whisper.cpp",
    "build",
    "bin",
    "whisper-cli"
  );

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(
    __dirname,
    "..",
    "models",
    "ggml-small.en.bin"
  );

const WHISPER_THREADS = String(
  process.env.WHISPER_THREADS || "4"
);

const WHISPER_BEAM_SIZE = String(
  process.env.WHISPER_BEAM_SIZE || "10"
);

const WHISPER_BEST_OF = String(
  process.env.WHISPER_BEST_OF || "10"
);

const WHISPER_PROMPT = (
  process.env.WHISPER_PROMPT ||
  "Farex. Pull my pearl. Ender pearl. Stasis chamber. Minecraft."
).trim();

const VOICE_TRIGGER = (
  process.env.VOICE_TRIGGER || "Farex pull my pearl"
)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const VOICE_TRIGGER_PLAYER =
  process.env.VOICE_TRIGGER_PLAYER || "Farex";

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");
if (!PULL_API_TOKEN) {
  throw new Error("Missing PULL_API_TOKEN or STASIS_TOKEN");
}

const pullCommand = new SlashCommandBuilder()
  .setName("pull")
  .setDescription("Pull a player from their stasis chamber")
  .addStringOption(option =>
    option
      .setName("player")
      .setDescription("Minecraft player")
      .setRequired(true)
      .setAutocomplete(true)
  );

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription(
    "Join your voice channel and listen for the pearl voice command"
  );

const leaveCommand = new SlashCommandBuilder()
  .setName("leave")
  .setDescription(
    "Leave the current voice channel and stop listening"
  );

const commands = [
  pullCommand.toJSON(),
  joinCommand.toJSON(),
  leaveCommand.toJSON()
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const voiceSessions = new Map();
let cachedPlayers = [];
let refreshingPlayers = false;
const eventLoopMonitor = monitorEventLoopDelay({
  resolution: 20
});

eventLoopMonitor.enable();

function logInteractionTiming(interaction) {
  const ageMs = Date.now() - interaction.createdTimestamp;

  console.log(
    "[Discord] Interaction received:",
    {
      command: interaction.commandName,
      ageMs,
      gatewayPing: client.ws.ping,
      eventLoopMaxDelayMs:
        Math.round(eventLoopMonitor.max / 1e6)
    }
  );

  eventLoopMonitor.reset();

  return ageMs;
}


async function testDiscordRest() {
  const started = Date.now();

  try {
    const response = await fetch(
      "https://discord.com/api/v10/gateway",
      {
        signal: AbortSignal.timeout(2000)
      }
    );

    console.log(
      "[Discord] REST connectivity:",
      response.status,
      Date.now() - started + "ms",
      "DNS order=ipv4first"
    );
  } catch (error) {
    console.error(
      "[Discord] REST connectivity check failed:",
      {
        error: error?.message || String(error),
        durationMs: Date.now() - started
      }
    );
  }
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(
        DISCORD_CLIENT_ID,
        DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log(
      "Registered /pull, /join and /leave as guild commands"
    );
  } else {
    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log(
      "Registered /pull, /join and /leave as global commands"
    );
  }
}

async function getState() {
  const response = await fetch(STASIS_API_URL + "/api/state", {
    signal: AbortSignal.timeout(2500)
  });

  if (!response.ok) {
    throw new Error(
      "Stasis API returned HTTP " + response.status
    );
  }

  return response.json();
}

function uniquePlayers(state) {
  const seen = new Map();

  for (const chamber of state.chambers || []) {
    if (!chamber.player || chamber.status === "empty") continue;

    const key = chamber.player.toLowerCase();

    if (!seen.has(key)) {
      seen.set(key, chamber.player);
    }
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

async function refreshPlayers() {
  if (refreshingPlayers) return;

  refreshingPlayers = true;

  try {
    const state = await getState();
    cachedPlayers = uniquePlayers(state);
  } catch (error) {
    console.error(
      "[Discord] player cache refresh failed:",
      error.message
    );
  } finally {
    refreshingPlayers = false;
  }
}

async function safeAutocompleteRespond(interaction, choices) {
  try {
    await interaction.respond(choices);
  } catch (error) {
    if (error?.code === 10062) return;

    console.error(
      "[Discord] autocomplete response failed:",
      error
    );
  }
}

async function acknowledgeCommand(interaction, content) {
  const age = Date.now() - interaction.createdTimestamp;

  if (age > 2000) {
    console.warn(
      "[Discord] Slow interaction before acknowledgement: " +
        age +
        "ms, command=/" +
        interaction.commandName
    );
  }

  try {
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral
    });

    return true;
  } catch (error) {
    console.error("[Discord] Initial interaction reply failed:", {
      code: error?.code,
      status: error?.status,
      command: interaction.commandName,
      ageMs: Date.now() - interaction.createdTimestamp,
      gatewayPing: client.ws.ping,
      error: error?.message || String(error)
    });

    return false;
  }
}

async function editCommand(interaction, content) {
  try {
    await interaction.editReply(content);
    return true;
  } catch (error) {
    console.error("[Discord] Interaction edit failed:", {
      code: error?.code,
      command: interaction.commandName,
      error: error?.message || String(error)
    });

    return false;
  }
}

function normalizeSpeech(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from(
    { length: rows },
    () => Array(cols).fill(0)
  );

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : Math.min(
              dp[i - 1][j] + 1,
              dp[i][j - 1] + 1,
              dp[i - 1][j - 1] + 1
            );
    }
  }

  return dp[rows - 1][cols - 1];
}

function wordMatches(word, target, maxDistance) {
  return (
    word === target ||
    editDistance(word, target) <= maxDistance
  );
}

function containsWordNear(words, target, maxDistance) {
  return words.some(word =>
    wordMatches(word, target, maxDistance)
  );
}

function containsNameNear(words) {
  for (let i = 0; i < words.length; i++) {
    const one = words[i];

    if (wordMatches(one, "farex", 2)) {
      return true;
    }

    if (i + 1 < words.length) {
      const joined = one + words[i + 1];

      if (wordMatches(joined, "farex", 2)) {
        return true;
      }
    }
  }

  return false;
}

function phraseMatches(text) {
  const normalized = normalizeSpeech(text);
  const words = normalized.split(" ").filter(Boolean);

  if (!words.length) {
    return false;
  }

  if (normalized.includes(VOICE_TRIGGER)) {
    return true;
  }

  // Whisper may hear "Farex" as "fair ex", "fare ex", "far x", etc.
  // Require the two meaningful action words as well to avoid false triggers.
  return (
    containsNameNear(words) &&
    containsWordNear(words, "pull", 1) &&
    containsWordNear(words, "pearl", 2)
  );
}

async function pullPlayer(player) {
  const response = await fetch(
    STASIS_API_URL + "/api/pull-player",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stasis-Pull-Token": PULL_API_TOKEN
      },
      body: JSON.stringify({ player }),
      signal: AbortSignal.timeout(5000)
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      result.error || "Pull failed"
    );

    error.status = response.status;
    error.availableBases = result.availableBases;
    throw error;
  }

  return result;
}

function runWhisper(audioPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WHISPER_CLI_PATH)) {
      reject(
        new Error(
          "whisper-cli not found at " +
            WHISPER_CLI_PATH +
            ". Run bot/setup-whisper.sh or set WHISPER_CLI_PATH."
        )
      );
      return;
    }

    if (!fs.existsSync(WHISPER_MODEL_PATH)) {
      reject(
        new Error(
          "Whisper model not found at " +
            WHISPER_MODEL_PATH +
            ". Run bot/setup-whisper.sh or set WHISPER_MODEL_PATH."
        )
      );
      return;
    }

    const args = [
      "-m",
      WHISPER_MODEL_PATH,
      "-f",
      audioPath,
      "-l",
      "en",
      "-nt",
      "-np",
      "-t",
      WHISPER_THREADS,
      "-bs",
      WHISPER_BEAM_SIZE,
      "-bo",
      WHISPER_BEST_OF,
      "-tp",
      "0",
      "-nf",
      "-mc",
      "0",
      "-sns",
      "--prompt",
      WHISPER_PROMPT
    ];

    const child = spawn(
      WHISPER_CLI_PATH,
      args,
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      const text = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .join(" ");

      if (code !== 0) {
        reject(
          new Error(
            "whisper-cli exited with code " +
              code +
              (stderr.trim()
                ? ": " + stderr.trim().slice(-500)
                : "")
          )
        );
        return;
      }

      resolve(normalizeSpeech(text));
    });
  });
}

async function transcribeOgg(oggData) {
  if (!oggData || !oggData.length) {
    return "";
  }

  const tempPath = path.join(
    os.tmpdir(),
    "stasis-voice-" +
      process.pid +
      "-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      ".ogg"
  );

  try {
    fs.writeFileSync(tempPath, oggData);

    console.log(
      "[STT] Transcribing " +
        oggData.length +
        " bytes of OGG audio"
    );

    return await runWhisper(tempPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function destroyVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);

  if (!session) return;

  for (const stream of session.streams.values()) {
    stream.destroy();
  }

  session.streams.clear();
  session.connection.receiver.speaking.removeAllListeners("start");
  session.connection.destroy();
  voiceSessions.delete(guildId);

  console.log("[VOICE] Left guild " + guildId);
}

function startSpeechStream(session, userId) {
  if (userId !== session.listenerUserId) return;

  const now = Date.now();

  if (session.cooldownUntil && now < session.cooldownUntil) {
    return;
  }

  if (session.streams.has(userId)) {
    return;
  }

  const opusStream = session.connection.receiver.subscribe(
    userId,
    {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1200
      }
    }
  );

  // Discord voice is 48 kHz Opus stereo. Keep it in a proper OGG container
  // rather than writing raw decoded PCM with a guessed WAV header. whisper-cli
  // can decode OGG directly and performs the required audio conversion.
  const oggStream = new prism.opus.OggLogicalBitstream({
    opusHead: new prism.opus.OpusHead({
      channelCount: 2,
      sampleRate: 48000
    }),
    pageSizeControl: {
      maxPackets: 10
    }
  });

  const chunks = [];

  const streamState = {
    opusStream,
    oggStream,
    chunks,
    cleaned: false
  };

  session.streams.set(userId, streamState);

  console.log(
    "[STT] Listening to user " +
      session.listenerName +
      " for \"" +
      VOICE_TRIGGER +
      "\""
  );

  oggStream.on("data", chunk => {
    chunks.push(Buffer.from(chunk));
  });

  const cleanup = async () => {
    if (streamState.cleaned) return;
    streamState.cleaned = true;

    if (session.streams.get(userId) === streamState) {
      session.streams.delete(userId);
    }

    const oggData = Buffer.concat(chunks);

    if (!oggData.length || session.cooldownUntil > Date.now()) {
      return;
    }

    try {
      const text = await transcribeOgg(oggData);

      if (!text) {
        console.log("[STT] No speech recognized");
        return;
      }

      console.log(
        "[STT] " +
          session.listenerName +
          ": " +
          text
      );

      const matched = phraseMatches(text);

      if (!matched) {
        return;
      }

      console.log(
        "[STT] Trigger detected: \"" +
          VOICE_TRIGGER +
          "\" -> pulling " +
          VOICE_TRIGGER_PLAYER
      );

      session.cooldownUntil = Date.now() + 5000;

      try {
        const result = await pullPlayer(
          VOICE_TRIGGER_PLAYER
        );

        console.log(
          "[STT] Pull sent for " +
            result.player +
            " from Base " +
            result.base +
            " / Chamber " +
            String(result.chamber).padStart(2, "0")
        );
      } catch (error) {
        console.error(
          "[STT] Voice pull failed:",
          error.message
        );

        session.cooldownUntil = Date.now() + 1500;
      }
    } catch (error) {
      console.error(
        "[STT] Transcription failed:",
        error.message
      );
    }
  };

  oggStream.on("end", () => {
    void cleanup();
  });

  oggStream.on("close", () => {
    void cleanup();
  });

  oggStream.on("error", error => {
    console.error(
      "[STT] OGG stream error:",
      error.message
    );

    void cleanup();
  });

  opusStream.on("error", error => {
    console.error(
      "[STT] Voice receive error:",
      error.message
    );

    void cleanup();
  });

  opusStream.pipe(oggStream);
}

async function joinVoice(interaction) {
  const channel = interaction.member?.voice?.channel;

  if (!channel) {
    throw new Error("Join a voice channel first.");
  }

  if (!channel.isVoiceBased()) {
    throw new Error("That is not a voice channel.");
  }

  const existing = voiceSessions.get(
    interaction.guildId
  );

  if (existing) {
    destroyVoiceSession(interaction.guildId);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true
  });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    15000
  );

  const session = {
    guildId: interaction.guildId,
    channelId: channel.id,
    listenerUserId: interaction.user.id,
    listenerName: interaction.user.username,
    connection,
    streams: new Map(),
    triggered: false
  };

  voiceSessions.set(interaction.guildId, session);

  connection.on("error", error => {
    console.error(
      "[VOICE] Connection error:",
      error.message
    );
  });

  connection.receiver.speaking.on(
    "start",
    userId => {
      startSpeechStream(session, userId);
    }
  );

  return session;
}

client.on("interactionCreate", async interaction => {
  const ageMs = logInteractionTiming(interaction);

  if (ageMs > 2500) {
    console.warn(
      "[Discord] Interaction arrived too late for a reliable acknowledgement:",
      ageMs + "ms"
    );
  }

  if (interaction.isAutocomplete()) {
    const query =
      interaction.options
        .getString("player")
        ?.toLowerCase() || "";

    const choices = cachedPlayers
      .filter(player =>
        player.toLowerCase().includes(query)
      )
      .slice(0, 25)
      .map(player => ({
        name: player,
        value: player
      }));

    await safeAutocompleteRespond(
      interaction,
      choices
    );

    void refreshPlayers();
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "pull") {
    const player = interaction.options.getString(
      "player",
      true
    );

    if (
      !(await acknowledgeCommand(
        interaction,
        "⏳ Processing pull request..."
      ))
    ) {
      return;
    }

    try {
      const result = await pullPlayer(player);

      await editCommand(
        interaction,
        "✅ Pull command sent for **" +
          result.player +
          "** from **Base " +
          result.base +
          " / Chamber " +
          String(result.chamber).padStart(2, "0") +
          "**."
      );
    } catch (error) {
      let message =
        error.message || "Pull failed.";

      if (
        Array.isArray(error.availableBases) &&
        error.availableBases.length
      ) {
        message +=
          "\nAvailable bases: " +
          error.availableBases.join(", ") +
          ". Set the player's default base in the Stasis Control dashboard.";
      }

      await editCommand(
        interaction,
        "❌ " + message
      );
    }

    return;
  }

  if (interaction.commandName === "join") {
    if (
      !(await acknowledgeCommand(
        interaction,
        "🎙️ Connecting to your voice channel..."
      ))
    ) {
      return;
    }

    try {
      const session = await joinVoice(
        interaction
      );

      await editCommand(
        interaction,
        "🎙️ Joined <#" +
          session.channelId +
          "> and listening only to **" +
          session.listenerName +
          "**. Say **\"" +
          VOICE_TRIGGER +
          "\"** to pull **" +
          VOICE_TRIGGER_PLAYER +
          "**."
      );
    } catch (error) {
      console.error(
        "[VOICE] Join failed:",
        error
      );

      if (voiceSessions.has(interaction.guildId)) {
        destroyVoiceSession(interaction.guildId);
      }

      await editCommand(
        interaction,
        "❌ Unable to join voice: " +
          (error.message || "unknown error")
      );
    }

    return;
  }

  if (interaction.commandName === "leave") {
    destroyVoiceSession(interaction.guildId);

    await acknowledgeCommand(
      interaction,
      "👋 Left the voice channel and stopped listening."
    );
  }
});

client.once("clientReady", async () => {
  console.log(
    "Discord bot logged in as " +
      client.user.tag
  );
  console.log(
    "Using Stasis API: " + STASIS_API_URL
  );
  console.log(
    "Voice trigger: " + VOICE_TRIGGER
  );
  console.log(
    "Voice trigger player: " +
      VOICE_TRIGGER_PLAYER
  );
  console.log(
    "Whisper CLI: " + WHISPER_CLI_PATH
  );
  console.log(
    "Whisper model: " + WHISPER_MODEL_PATH
  );
  console.log(
    "Whisper beam/best-of: " +
      WHISPER_BEAM_SIZE +
      "/" +
      WHISPER_BEST_OF
  );
  console.log(
    "Whisper audio input: Discord Opus -> OGG 48kHz stereo"
  );
  console.log(
    "Whisper prompt: " + WHISPER_PROMPT
  );
  console.log(
    "DNS result order: " + dns.getDefaultResultOrder()
  );

  void testDiscordRest();

  if (!fs.existsSync(WHISPER_CLI_PATH)) {
    console.error(
      "[STT] whisper-cli is not installed. Run bot/setup-whisper.sh."
    );
  } else if (!fs.existsSync(WHISPER_MODEL_PATH)) {
    console.error(
      "[STT] Whisper model is not installed. Run bot/setup-whisper.sh."
    );
  } else {
    console.log("[STT] Whisper STT is ready");
  }

  await refreshPlayers();

  setInterval(() => {
    void refreshPlayers();
  }, 10000);
});

function shutdown() {
  for (const guildId of [...voiceSessions.keys()]) {
    destroyVoiceSession(guildId);
  }

  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {
  console.log(
    "[Discord] Gateway ping:",
    client.ws.ping + "ms",
    "| Event-loop max delay:",
    Math.round(eventLoopMonitor.max / 1e6) + "ms"
  );
  eventLoopMonitor.reset();
}, 30000);

process.on("unhandledRejection", error => {
  console.error("[Discord] Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("[Discord] Uncaught exception:", error);
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
