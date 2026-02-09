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

// ---- helpers to sanitize env vars coming from Render UI ----
function cleanEnv(v) {
  if (v == null) return "";
  let s = String(v);

  // remove common accidental wrapping quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }

  // trim whitespace + newlines
  s = s.trim();

  return s;
}

const DISCORD_TOKEN = cleanEnv(process.env.DISCORD_TOKEN);
const DISCORD_CLIENT_ID = cleanEnv(process.env.DISCORD_CLIENT_ID);

// Hard fail early with clear reasons (Render logs)
if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN (Render Environment)");
if (!DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID (Render Environment)");

// If token still contains whitespace inside, it’s definitely pasted wrong
if (/\s/.test(DISCORD_TOKEN)) {
  throw new Error("DISCORD_TOKEN contains whitespace/newlines. Re-paste token in Render (no spaces/quotes).");
}

console.log(`Starting NeuroBridge… (token length=${DISCORD_TOKEN.length}, clientId=${DISCORD_CLIENT_ID})`);

const pendingByUser = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

const commands = [
  new SlashCommandBuilder()
    .setName("compose")
    .setDescription("Privately write → AI rewrites → send only the rewritten message."),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
}

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

client.on("interactionCreate", async (interaction) => {
  try {
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

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId === "nb_compose_modal") {
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
          await interaction.editReply({ content: "No pending rewrite found. Run /compose again.", components: [] });
          return;
        }

        if (pending.channelId !== interaction.channelId) {
          await interaction.editReply({
            content: "That rewrite was created in a different channel. Run /compose again here.",
            components: [],
          });
          return;
        }

        try {
          await sendViaWebhook(interaction, pending.rewrittenText);
        } catch {
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
        await interaction.editReply({ content: `Error: ${err.message || String(err)}`, components: [] });
      } else if (!interaction.replied) {
        await interaction.reply({ content: `Error: ${err.message || String(err)}`, ephemeral: true });
      }
    } catch {}
  }
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  console.log("✅ Slash commands registered.");
  await client.login(DISCORD_TOKEN);
})();
