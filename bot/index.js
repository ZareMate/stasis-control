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

const WHISPER_SERVER_PATH =
  process.env.WHISPER_SERVER_PATH ||
  path.join(
    __dirname,
    "..",
    "whisper.cpp",
    "build",
    "bin",
    "whisper-server"
  );

const WHISPER_SERVER_PORT = Number(
  process.env.WHISPER_SERVER_PORT || 39781
);

const WHISPER_SERVER_URL = (
  process.env.WHISPER_SERVER_URL ||
  "http://127.0.0.1:" + WHISPER_SERVER_PORT
).replace(/\/+$/, "");

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(
    __dirname,
    "..",
    "models",
    "ggml-large-v3-turbo.bin"
  );

const WHISPER_THREADS = String(
  process.env.WHISPER_THREADS ||
    Math.max(4, Math.min(8, os.cpus().length))
);

const VOICE_TRIGGER = (
  process.env.VOICE_TRIGGER || "home"
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

let whisperServerProcess = null;
let whisperServerReady = false;
let whisperServerStartPromise = null;
let shuttingDown = false;

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

  for (let i = 0; i < rows; i++) {
    dp[i][0] = i;
  }

  for (let j = 0; j < cols; j++) {
    dp[0][j] = j;
  }

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

function similarWord(word, target, maxDistance) {
  if (!word || !target) {
    return false;
  }

  if (word === target) {
    return true;
  }

  if (word.length < target.length - maxDistance) {
    return false;
  }

  if (word.length > target.length + maxDistance) {
    return false;
  }

  return editDistance(word, target) <= maxDistance;
}

function matchFarex(words) {
  for (let i = 0; i < words.length; i++) {
    if (
      similarWord(words[i], "farex", 2) ||
      similarWord(words[i], "ferex", 1) ||
      similarWord(words[i], "parax", 1)
    ) {
      return i;
    }

    if (i + 1 < words.length) {
      const joined = words[i] + words[i + 1];

      if (similarWord(joined, "farex", 2)) {
        return i;
      }
    }
  }

  return -1;
}

function matchPull(words, startIndex) {
  for (let i = startIndex; i < words.length; i++) {
    const word = words[i];

    if (
      similarWord(word, "pull", 2) ||
      word.startsWith("pul")
    ) {
      return i;
    }
  }

  return -1;
}

function matchPearl(words, startIndex) {
  const aliases = [
    "pearl",
    "peril",
    "purl",
    "barrel"
  ];

  for (let i = startIndex; i < words.length; i++) {
    const word = words[i];

    if (
      aliases.some(alias =>
        similarWord(word, alias, alias === "barrel" ? 0 : 2)
      )
    ) {
      return i;
    }
  }

  return -1;
}

function phraseMatches(text) {
  const normalized = normalizeSpeech(text);
  const words = normalized.split(" ").filter(Boolean);

  if (!words.length || !VOICE_TRIGGER) {
    return false;
  }

  // The voice command is intentionally just the trigger word.
  // Allow small Whisper transcription errors such as "pulmai" for "pull".
  const triggerWords = VOICE_TRIGGER.split(" ").filter(Boolean);

  if (triggerWords.length === 1) {
    const trigger = triggerWords[0];

    return words.some(word =>
      similarWord(word, trigger, 2) ||
      (trigger.length >= 3 && word.startsWith(trigger.slice(0, 3)))
    );
  }

  // Keep support for a custom multi-word trigger, while requiring
  // the words to appear in order.
  let searchStart = 0;

  for (const trigger of triggerWords) {
    let found = -1;

    for (let i = searchStart; i < words.length; i++) {
      if (similarWord(words[i], trigger, 2)) {
        found = i;
        break;
      }
    }

    if (found < 0) {
      return false;
    }

    searchStart = found + 1;
  }

  return true;
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

function writeWav(filePath, pcm) {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(
    filePath,
    Buffer.concat([header, pcm])
  );
}

async function waitForWhisperServer(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (
      whisperServerProcess &&
      whisperServerProcess.exitCode !== null
    ) {
      throw new Error(
        "whisper-server exited with code " +
          whisperServerProcess.exitCode
      );
    }

    try {
      const response = await fetch(
        WHISPER_SERVER_URL + "/",
        {
          signal: AbortSignal.timeout(1000)
        }
      );

      if (response.ok) {
        whisperServerReady = true;
        return;
      }
    } catch {}

    await new Promise(resolve =>
      setTimeout(resolve, 250)
    );
  }

  throw new Error(
    "Timed out waiting for whisper-server at " +
      WHISPER_SERVER_URL
  );
}

async function startWhisperServer() {
  if (whisperServerReady && whisperServerProcess) {
    return;
  }

  if (whisperServerStartPromise) {
    return whisperServerStartPromise;
  }

  whisperServerStartPromise = (async () => {
    if (!fs.existsSync(WHISPER_SERVER_PATH)) {
      throw new Error(
        "whisper-server not found at " +
          WHISPER_SERVER_PATH +
          ". Run bot/setup-whisper.sh or set WHISPER_SERVER_PATH."
      );
    }

    if (!fs.existsSync(WHISPER_MODEL_PATH)) {
      throw new Error(
        "Whisper model not found at " +
          WHISPER_MODEL_PATH +
          ". Run bot/setup-whisper.sh or set WHISPER_MODEL_PATH."
      );
    }

    if (
      whisperServerProcess &&
      whisperServerProcess.exitCode === null
    ) {
      whisperServerProcess.kill("SIGTERM");
    }

    whisperServerReady = false;

    console.log(
      "[STT] Starting persistent whisper-server..."
    );

    whisperServerProcess = spawn(
      WHISPER_SERVER_PATH,
      [
        "-m",
        WHISPER_MODEL_PATH,
        "-t",
        WHISPER_THREADS,
        "-p",
        "1",
        "-bo",
        "1",
        "-bs",
        "1",
        "-nf",
        "--host",
        "127.0.0.1",
        "--port",
        String(WHISPER_SERVER_PORT)
      ],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    whisperServerProcess.stdout.on(
      "data",
      chunk => {
        const output = chunk
          .toString()
          .trim();

        if (output) {
          console.log("[WHISPER] " + output);
        }
      }
    );

    whisperServerProcess.stderr.on(
      "data",
      chunk => {
        const output = chunk
          .toString()
          .trim();

        if (output) {
          console.log("[WHISPER] " + output);
        }
      }
    );

    whisperServerProcess.on(
      "error",
      error => {
        whisperServerReady = false;
        console.error(
          "[STT] whisper-server process error:",
          error.message
        );
      }
    );

    whisperServerProcess.on(
      "exit",
      (code, signal) => {
        const wasExpected = shuttingDown;

        whisperServerReady = false;
        whisperServerProcess = null;

        if (!wasExpected) {
          console.error(
            "[STT] whisper-server stopped:",
            { code, signal }
          );
        }
      }
    );

    await waitForWhisperServer();
    console.log(
      "[STT] Persistent Whisper server ready at " +
        WHISPER_SERVER_URL
    );
  })();

  try {
    await whisperServerStartPromise;
  } finally {
    whisperServerStartPromise = null;
  }
}

async function transcribeViaWhisperServer(wavPath) {
  await startWhisperServer();

  const form = new FormData();
  form.append(
    "file",
    new Blob(
      [fs.readFileSync(wavPath)],
      { type: "audio/wav" }
    ),
    path.basename(wavPath)
  );
  form.append("response_format", "json");
  form.append("language", "en");
  form.append("temperature", "0.0");
  form.append("temperature_inc", "0.2");
  form.append("best_of", "1");
  form.append("beam_size", "1");
  form.append("no_timestamps", "true");
  form.append("no_context", "true");
  form.append("no_language_probabilities", "true");
  form.append("suppress_nst", "true");

  const response = await fetch(
    WHISPER_SERVER_URL + "/inference",
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000)
    }
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      "whisper-server returned HTTP " +
        response.status +
        ": " +
        bodyText.slice(-500)
    );
  }

  let result;

  try {
    result = JSON.parse(bodyText);
  } catch {
    return normalizeSpeech(bodyText);
  }

  return normalizeSpeech(
    typeof result === "string"
      ? result
      : result.text || ""
  );
}

async function transcribePcm(pcm) {
  if (!pcm.length) return "";

  const tempPath = path.join(
    os.tmpdir(),
    "stasis-voice-" +
      process.pid +
      "-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      ".wav"
  );

  try {
    writeWav(tempPath, pcm);
    return await transcribeViaWhisperServer(tempPath);
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
  if (session.triggered) return;
  if (session.streams.has(userId)) return;

  const silenceDuration = Math.max(
    250,
    Number(process.env.VOICE_SILENCE_MS || 450)
  );

  const opusStream = session.connection.receiver.subscribe(
    userId,
    {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: silenceDuration
      }
    }
  );

  const decoder = new prism.opus.Decoder({
    rate: 16000,
    channels: 1,
    frameSize: 960
  });

  const chunks = [];

  const streamState = {
    opusStream,
    decoder,
    chunks
  };

  session.streams.set(userId, streamState);

  console.log(
    "[STT] Listening to user " +
      session.listenerName +
      " for \"" +
      VOICE_TRIGGER +
      "\""
  );

  decoder.on("data", data => {
    if (!session.triggered) {
      chunks.push(Buffer.from(data));
    }
  });

  const cleanup = async () => {
    if (session.streams.get(userId) !== streamState) {
      return;
    }

    session.streams.delete(userId);

    const pcm = Buffer.concat(chunks);

    if (!pcm.length || session.triggered) {
      return;
    }

    try {
      const text = await transcribePcm(pcm);

      if (!text) {
        return;
      }

      console.log(
        "[STT] " +
          session.listenerName +
          ": " +
          text
      );

      if (!session.triggered && phraseMatches(text)) {
        session.triggered = true;

        console.log(
          "[STT] Trigger detected: \"" +
            VOICE_TRIGGER +
            "\" -> pulling " +
            VOICE_TRIGGER_PLAYER
        );

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

          session.triggered = false;
        }
      }
    } catch (error) {
      console.error(
        "[STT] Transcription failed:",
        error.message
      );
    }
  };

  decoder.on("end", () => {
    void cleanup();
  });

  decoder.on("close", () => {
    void cleanup();
  });

  decoder.on("error", error => {
    console.error(
      "[STT] Decoder error:",
      error.message
    );

    void cleanup();
  });

  opusStream.on("error", error => {
    console.error(
      "[STT] Voice receive error:",
      error.message
    );
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
    "Voice trigger word: " + VOICE_TRIGGER
  );
  console.log(
    "Voice silence: " +
      Number(process.env.VOICE_SILENCE_MS || 450) +
      "ms"
  );
  console.log(
    "Voice trigger player: " +
      VOICE_TRIGGER_PLAYER
  );
  console.log(
    "Whisper server: " + WHISPER_SERVER_PATH
  );
  console.log(
    "Whisper server URL: " + WHISPER_SERVER_URL
  );
  console.log(
    "Whisper model: " + WHISPER_MODEL_PATH
  );
  console.log(
    "DNS result order: " + dns.getDefaultResultOrder()
  );

  void testDiscordRest();

  try {
    await startWhisperServer();
  } catch (error) {
    console.error(
      "[STT] Failed to start persistent Whisper server:",
      error.message
    );
  }

  await refreshPlayers();

  setInterval(() => {
    void refreshPlayers();
  }, 10000);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const guildId of [...voiceSessions.keys()]) {
    destroyVoiceSession(guildId);
  }

  if (
    whisperServerProcess &&
    whisperServerProcess.exitCode === null
  ) {
    console.log("[STT] Stopping persistent Whisper server...");

    try {
      whisperServerProcess.kill("SIGTERM");
    } catch {}
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
  await startWhisperServer();
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})().catch(error => {
  console.error("[FATAL] Bot startup failed:", error);
  shutdown();
});
