require("dotenv").config();

const fs = require("fs");
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
const vosk = require("vosk");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const STASIS_PORT = process.env.STASIS_PORT || process.env.PORT || "3000";
const STASIS_API_URL = (
  process.env.STASIS_API_URL || "http://127.0.0.1:" + STASIS_PORT
).replace(/\/+$/, "");
const PULL_API_TOKEN =
  process.env.PULL_API_TOKEN || process.env.STASIS_TOKEN;

const VOSK_MODEL_PATH =
  process.env.VOSK_MODEL_PATH ||
  "./models/vosk-model-small-en-us-0.15";

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
  .setDescription("Join your voice channel and listen for the pearl voice command");

const leaveCommand = new SlashCommandBuilder()
  .setName("leave")
  .setDescription("Leave the current voice channel and stop listening");

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
let voskModel = null;

function loadVoskModel() {
  if (voskModel) {
    return voskModel;
  }

  if (!fs.existsSync(VOSK_MODEL_PATH)) {
    throw new Error(
      "Vosk model not found at " +
        VOSK_MODEL_PATH +
        ". Run bot/download-model.sh or set VOSK_MODEL_PATH."
    );
  }

  vosk.setLogLevel(0);
  console.log("[STT] Loading Vosk model from " + VOSK_MODEL_PATH);
  voskModel = new vosk.Model(VOSK_MODEL_PATH);
  console.log("[STT] Vosk model loaded");

  return voskModel;
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

    console.log("Registered /pull, /join and /leave as guild commands");
  } else {
    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log("Registered /pull, /join and /leave as global commands");
  }
}

async function getState() {
  const response = await fetch(STASIS_API_URL + "/api/state", {
    signal: AbortSignal.timeout(2500)
  });

  if (!response.ok) {
    throw new Error("Stasis API returned HTTP " + response.status);
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
    console.error("[Discord] player cache refresh failed:", error.message);
  } finally {
    refreshingPlayers = false;
  }
}

async function safeAutocompleteRespond(interaction, choices) {
  try {
    await interaction.respond(choices);
  } catch (error) {
    if (error?.code === 10062) {
      return;
    }

    console.error("[Discord] autocomplete response failed:", error);
  }
}

function normalizeSpeech(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phraseMatches(text) {
  return normalizeSpeech(text).includes(VOICE_TRIGGER);
}

async function pullPlayer(player) {
  const response = await fetch(STASIS_API_URL + "/api/pull-player", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Stasis-Pull-Token": PULL_API_TOKEN
    },
    body: JSON.stringify({ player }),
    signal: AbortSignal.timeout(5000)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(result.error || "Pull failed");
    error.status = response.status;
    error.availableBases = result.availableBases;
    throw error;
  }

  return result;
}

function destroyVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);

  if (!session) {
    return;
  }

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
  if (userId !== session.listenerUserId) {
    return;
  }

  if (session.triggered) {
    return;
  }

  if (session.streams.has(userId)) {
    return;
  }

  let model;

  try {
    model = loadVoskModel();
  } catch (error) {
    console.error("[STT] " + error.message);
    return;
  }

  const recognizer = new vosk.Recognizer({
    model,
    sampleRate: 16000
  });

  const opusStream = session.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 900
    }
  });

  const decoder = new prism.opus.Decoder({
    rate: 16000,
    channels: 1,
    frameSize: 960
  });

  const state = {
    recognizer,
    opusStream,
    decoder
  };

  session.streams.set(userId, state);

  console.log(
    "[STT] Listening to user " +
      userId +
      " for \"" +
      VOICE_TRIGGER +
      "\""
  );

  const checkText = async text => {
    const normalized = normalizeSpeech(text);

    if (!normalized) {
      return false;
    }

    console.log("[STT] " + userId + ": " + normalized);

    if (!session.triggered && phraseMatches(normalized)) {
      session.triggered = true;

      console.log(
        "[STT] Trigger detected: \"" +
          VOICE_TRIGGER +
          "\" -> pulling " +
          VOICE_TRIGGER_PLAYER
      );

      try {
        const result = await pullPlayer(VOICE_TRIGGER_PLAYER);

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
      }

      return true;
    }

    return false;
  };

  decoder.on("data", data => {
    if (session.triggered) {
      return;
    }

    try {
      const done = recognizer.acceptWaveform(data);

      if (done) {
        const result = JSON.parse(recognizer.result());
        void checkText(result.text);
      } else {
        const partial = JSON.parse(recognizer.partialResult());
        void checkText(partial.partial);
      }
    } catch (error) {
      console.error("[STT] Recognition error:", error.message);
    }
  });

  const cleanup = () => {
    if (session.streams.get(userId) !== state) {
      return;
    }

    try {
      const finalResult = JSON.parse(recognizer.finalResult());
      void checkText(finalResult.text);
    } catch (error) {
      console.error("[STT] Final recognition error:", error.message);
    }

    try {
      recognizer.free();
    } catch {}

    session.streams.delete(userId);
  };

  decoder.on("end", cleanup);
  decoder.on("close", cleanup);
  decoder.on("error", error => {
    console.error("[STT] Decoder error:", error.message);
    cleanup();
  });

  opusStream.on("error", error => {
    console.error("[STT] Voice receive error:", error.message);
  });

  opusStream.pipe(decoder);
}

async function joinVoice(interaction) {
  const channel = interaction.member?.voice?.channel;

  if (!channel) {
    throw new Error("Join a voice channel first.");
  }

  if (!channel.isVoiceBased()) {
    throw new Error("That is not a voice channel.");
  }

  const existing = voiceSessions.get(interaction.guildId);

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

  await entersState(connection, VoiceConnectionStatus.Ready, 15000);

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
    console.error("[VOICE] Connection error:", error.message);
  });

  connection.receiver.speaking.on("start", userId => {
    startSpeechStream(session, userId);
  });

  return session;
}

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    const query =
      interaction.options.getString("player")?.toLowerCase() || "";

    const choices = cachedPlayers
      .filter(player => player.toLowerCase().includes(query))
      .slice(0, 25)
      .map(player => ({
        name: player,
        value: player
      }));

    await safeAutocompleteRespond(interaction, choices);
    void refreshPlayers();
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "pull") {
    const player = interaction.options.getString("player", true);

    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    try {
      const result = await pullPlayer(player);

      await interaction.editReply(
        "✅ Pull command sent for **" +
          result.player +
          "** from **Base " +
          result.base +
          " / Chamber " +
          String(result.chamber).padStart(2, "0") +
          "**."
      );
    } catch (error) {
      let message = error.message || "Pull failed.";

      if (
        Array.isArray(error.availableBases) &&
        error.availableBases.length
      ) {
        message +=
          "\\nAvailable bases: " +
          error.availableBases.join(", ") +
          ". Set the player's default base in the Stasis Control dashboard.";
      }

      await interaction.editReply("❌ " + message);
    }

    return;
  }

  if (interaction.commandName === "join") {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    try {
      const session = await joinVoice(interaction);

      await interaction.editReply(
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
      console.error("[VOICE] Join failed:", error);

      if (voiceSessions.has(interaction.guildId)) {
        destroyVoiceSession(interaction.guildId);
      }

      await interaction.editReply(
        "❌ Unable to join voice: " +
          (error.message || "unknown error")
      );
    }

    return;
  }

  if (interaction.commandName === "leave") {
    destroyVoiceSession(interaction.guildId);

    await interaction.reply({
      content: "👋 Left the voice channel and stopped listening.",
      flags: MessageFlags.Ephemeral
    });
  }
});

client.once("clientReady", async () => {
  console.log("Discord bot logged in as " + client.user.tag);
  console.log("Using Stasis API: " + STASIS_API_URL);
  console.log("Voice trigger: " + VOICE_TRIGGER);
  console.log("Voice trigger player: " + VOICE_TRIGGER_PLAYER);

  try {
    loadVoskModel();
  } catch (error) {
    console.error("[STT] " + error.message);
    console.error(
      "[STT] Voice recognition will remain disabled until the model is installed."
    );
  }

  await refreshPlayers();

  setInterval(() => {
    void refreshPlayers();
  }, 10000);
});

process.on("SIGINT", () => {
  for (const guildId of [...voiceSessions.keys()]) {
    destroyVoiceSession(guildId);
  }

  if (voskModel) {
    try {
      voskModel.free();
    } catch {}
  }

  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const guildId of [...voiceSessions.keys()]) {
    destroyVoiceSession(guildId);
  }

  if (voskModel) {
    try {
      voskModel.free();
    } catch {}
  }

  client.destroy();
  process.exit(0);
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
