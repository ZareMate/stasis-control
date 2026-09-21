require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const STASIS_API_URL = (
  process.env.STASIS_API_URL || "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const PULL_API_TOKEN = process.env.PULL_API_TOKEN;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");
if (!PULL_API_TOKEN) throw new Error("Missing PULL_API_TOKEN");

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

const commands = [pullCommand.toJSON()];

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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

    console.log("Registered /pull as a guild command");
  } else {
    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log("Registered /pull as a global command");
  }
}

async function getState() {
  const response = await fetch(STASIS_API_URL + "/api/state");

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

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    try {
      const state = await getState();
      const players = uniquePlayers(state);
      const query = interaction.options.getString("player")?.toLowerCase() || "";

      await interaction.respond(
        players
          .filter(player => player.toLowerCase().includes(query))
          .slice(0, 25)
          .map(player => ({
            name: player,
            value: player
          }))
      );
    } catch {
      await interaction.respond([]);
    }

    return;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== "pull") {
    return;
  }

  const player = interaction.options.getString("player", true);

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const response = await fetch(STASIS_API_URL + "/api/pull-player", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stasis-Pull-Token": PULL_API_TOKEN
      },
      body: JSON.stringify({ player })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      let message = result.error || "Pull failed.";

      if (Array.isArray(result.availableBases) && result.availableBases.length) {
        message +=
          "\nAvailable bases: " +
          result.availableBases.join(", ") +
          ". Set the player's default base in the Stasis Control dashboard.";
      }

      await interaction.editReply("❌ " + message);
      return;
    }

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
    console.error("[Discord] pull error:", error);
    await interaction.editReply(
      "❌ Unable to contact the Stasis Control server."
    );
  }
});

client.once("ready", () => {
  console.log("Discord bot logged in as " + client.user.tag);
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
