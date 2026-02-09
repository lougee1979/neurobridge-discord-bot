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
  WebhookClient,
} = require("discord.js");

const { rewriteText } = require("./rewriteClient");

console.log("Starting NeuroBridge…");

const drafts = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function registerCommands() {
  if (!process.env.DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID");
  if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN");

  const commands = [
    new SlashCommandBuilder()
      .setName("compose")
      .setDescription("Privately write, rewrite, and send only the rewritten message.")
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

async function getOrCreateWebhook(channel) {
  const webhooks = await channel.fetchWebhooks();
  let hook = webhooks.find((w) => w.owner && w.owner.id === client.user.id);
  if (!hook) hook = await channel.createWebhook({ name: "NeuroBridge" });
  return hook;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "compose") {
      const modal = new ModalBuilder()
        .setCustomId("composeModal")
        .setTitle("NeuroBridge — Compose");

      const input = new TextInputBuilder()
        .setCustomId("composeText")
        .setLabel("Type what you want to say (private)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1800);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === "composeModal") {
      await interaction.deferReply({ ephemeral: true });

      const originalText = interaction.fields.getTextInputValue("composeText");
      const result = await rewriteText({ originalText });

      drafts.set(interaction.user.id, {
        rewritten: result.rewritten_text,
        channelId: interaction.channelId,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("sendRewrite")
          .setLabel("Send rewrite")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("cancelRewrite")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger)
      );

      return interaction.editReply({
        content: result.rewritten_text,
        components: [row],
      });
    }

    if (interaction.isButton()) {
      await interaction.deferReply({ ephemeral: true });

      const draft = drafts.get(interaction.user.id);
      if (!draft) return interaction.editReply("No active draft found. Run /compose again.");

      if (interaction.customId === "cancelRewrite") {
        drafts.delete(interaction.user.id);
        return interaction.editReply("Canceled.");
      }

      if (interaction.customId === "sendRewrite") {
        const channel = await client.channels.fetch(draft.channelId);

        const hook = await getOrCreateWebhook(channel);
        const webhookClient = new WebhookClient({ url: hook.url });

        await webhookClient.send({
          content: draft.rewritten,
          username: interaction.member?.displayName || interaction.user.username,
          avatarURL: interaction.user.displayAvatarURL(),
        });

        drafts.delete(interaction.user.id);
        return interaction.editReply("Sent. Only the rewrite was posted.");
      }
    }
  } catch (e) {
    const msg = e?.message ? e.message : String(e);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Error: ${msg}`);
      } else {
        await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
      }
    }
    console.error(e);
  }
});

(async () => {
  try {
    if (!process.env.DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
    if (!process.env.DISCORD_CLIENT_ID) throw new Error("Missing DISCORD_CLIENT_ID in .env");

    await client.login(process.env.DISCORD_TOKEN);
    await registerCommands();
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
