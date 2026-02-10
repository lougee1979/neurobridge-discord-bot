require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionType,
} = require("discord.js");

const { rewriteText } = require("./rewriteClient");

// ---- helpers to sanitize env vars (Render UI can add quotes/whitespace) ----
function cleanEnv(v) {
  if (v == null) return "";
  let s = String(v);

  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }

  return s.trim();
}

const DISCORD_TOKEN = cleanEnv(process.env.DISCORD_TOKEN);
const DISCORD_CLIENT_ID = cleanEnv(process.env.DISCORD_CLIENT_ID);
const DISCORD_GUILD_ID = cleanEnv(process.env.DISCORD_GUILD_ID); // optional but recommended for instant command updates

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN (Render Environment)");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID (Render Environment)");

if (/\s/.test(DISCORD_TOKEN)) {
  throw new Error(
    "DISCORD_TOKEN contains whitespace/newlines. Re-paste token in Render (no spaces/quotes)."
  );
}

console.log(
  `Starting NeuroBridge… (token length=${DISCORD_TOKEN.length}, clientId=${DISCORD_CLIENT_ID}, guildId=${DISCORD_GUILD_ID || "GLOBAL"})`
);

// In-memory store for pending rewrites per user (good enough for MVP)
const pendingByUser = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

// ---- Slash Commands ----
const commands = [
  new SlashCommandBuilder()
    .setName("compose")
    .setDescription("Privately write → AI rewrites → send only the rewritten message."),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (DISCORD_GUILD_ID) {
    // Guild commands update almost instantly (best for testing / demos)
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log(`✅ Slash commands registered (GUILD ${DISCORD_GUILD_ID}).`);
  } else {
    // Global commands can take time to propagate
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered (GLOBAL).");
  }
}

// ---- Webhook send (so only rewrite is posted and appears as the user) ----
async function sendViaWebhook(interaction, content) {
  const channel = interaction.channel;
  if (!channel) throw new Error("No channel found for webhook send");

  const hooks = await channel.fetchWebhooks();
  let hook = hooks.find((h) => h.owner && h.owner.id === client.user.id);

  if (!hook) {
    hook = await channel.createWebhook({
      name: "NeuroBridge",
      reason: "NeuroBridge rewrite sending",
    });
  }

  await hook.send({
    content,
    username: interaction.user.username,
    avatarURL: interaction.user.displayAvatarURL(),
  });
}

// ---- Main interaction handler ----
client.on("interactionCreate", async (interaction) => {
  try {
    // /compose -> show modal
    if (interaction.isChatInputCommand() && interaction.commandName === "compose") {
      const modal = new ModalBuilder()
        .setCustomId("nb_compose_modal")
        .setTitle("NeuroBridge — Compose");

      const input = new TextInputBuilder()
        .setCustomId("nb_original_text")
        .setLabel("Type what you want to say (private)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1800);

      modal.addComponents(new ActionRowBuilder().addComponents(input));

      await interaction.showModal(modal);
      return;
    }

    // Modal submit -> acknowledge immediately (prevents “Application did not respond”)
    if (
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId === "nb_compose_modal"
    ) {
      await interaction.deferReply({ ephemeral: true });

      const originalText = interaction.fields.getTextInputValue("nb_original_text");
      const { rewritten_text } = await rewriteText({ originalText });

      pendingByUser.set(interaction.user.id, {
        rewrittenText: rewritten_text,
        channelId: interaction.channelId,
        createdAt: Date.now(),
      });

      const sendBtn = new ButtonBuilder()
        .setCustomId("nb_send_rewrite")
        .setLabel("Send rewrite")
        .setStyle(ButtonStyle.Success);

      const cancelBtn = new ButtonBuilder()
        .setCustomId("nb_cancel_rewrite")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder().addComponents(sendBtn, cancelBtn);

      await interaction.editReply({
        content: `**Rewrite preview (only you can see this):**\n\n${rewritten_text}`,
        components: [row],
      });

      return;
    }

    // Buttons
    if (interaction.isButton()) {
      await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === "nb_cancel_rewrite") {
        pendingByUser.delete(interaction.user.id);
        await interaction.editReply({ content: "Cancelled.", components: [] });
        return;
      }

      if (interaction.customId === "nb_send_rewrite") {
        const pending = pendingByUser.get(interaction.user.id);

        if (!pending) {
          await interaction.editReply({
            content: "No pending rewrite found. Run /compose again.",
            components: [],
          });
          return;
        }

        if (pending.channelId !== interaction.channelId) {
          await interaction.editReply({
            content: "That rewrite was created in a different channel. Run /compose again here.",
            components: [],
          });
          return;
        }

        // Post only rewritten text
        try {
          await sendViaWebhook(interaction, pending.rewrittenText);
        } catch (e) {
          // Fallback if webhooks not allowed
          await interaction.channel.send(pending.rewrittenText);
        }

        pendingByUser.delete(interaction.user.id);
        await interaction.editReply({ content: "Sent.", components: [] });
        return;
      }
    }
  } catch (err) {
    console.error("Interaction error:", err);

    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content: `Error: ${err.message || String(err)}`,
          components: [],
        });
      } else if (!interaction.replied) {
        await interaction.reply({
          content: `Error: ${err.message || String(err)}`,
          ephemeral: true,
        });
      }
    } catch {
      // ignore secondary failures
    }
  }
});

// Use clientReady to avoid the v15 deprecation warning
client.once("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// ---- Start ----
(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
