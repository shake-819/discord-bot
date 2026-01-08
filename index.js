const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const schedule = require("node-schedule");
const http = require("http");
const crypto = require("crypto");
const Airtable = require("airtable");

console.log("BOOT START");

// ====== 環境変数 ======
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;



// ====== Airtable ======
const base = new Airtable({
    apiKey: AIRTABLE_TOKEN,
}).base(AIRTABLE_BASE_ID);

// ====== Discord client ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// ====== エラー監視 ======
process.on("uncaughtException", err => console.error("Uncaught:", err));
process.on("unhandledRejection", err => console.error("Unhandled:", err));

// ====== JST 日付 ======
function parseJSTDate(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setHours(date.getHours() + 9);
    return date;
}

// ====== Slash Commands ======
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("イベント追加")
        .addStringOption(o => o.setName("date").setDescription("YYYY-MM-DD").setRequired(true))
        .addStringOption(o => o.setName("message").setDescription("内容").setRequired(true)),
    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("イベント一覧"),
    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベント削除")
        .addIntegerOption(o => o.setName("index").setDescription("番号").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// ====== READY ======
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    try {
        await base(AIRTABLE_TABLE).select({ maxRecords: 1 }).firstPage();
        console.log("✅ Airtable connected");
    } catch (e) {
        console.error("❌ Airtable error:", e);
    }

    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );
});

// ====== interaction ======
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // ★ 修正点：安全に acknowledge
    try {
        await interaction.deferReply();
    } catch {
        return;
    }

    try {
        if (interaction.commandName === "addevent") {
            const date = interaction.options.getString("date");
            const message = interaction.options.getString("message");

            await base(AIRTABLE_TABLE).create({
                date,
                message,
                uid: crypto.randomBytes(16).toString("hex"),
            });

            return interaction.editReply(`追加しました ✅\n${date} - ${message}`);
        }

        if (interaction.commandName === "listevents") {
            const records = await base(AIRTABLE_TABLE)
                .select({ sort: [{ field: "date", direction: "asc" }] })
                .all();

            if (records.length === 0) {
                return interaction.editReply("イベントなし");
            }

            return interaction.editReply(
                records.map((r, i) =>
                    `${i + 1}. ${r.get("date")} - ${r.get("message")}`
                ).join("\n")
            );
        }

        if (interaction.commandName === "deleteevent") {
            const index = interaction.options.getInteger("index") - 1;

            const records = await base(AIRTABLE_TABLE)
                .select({ sort: [{ field: "date", direction: "asc" }] })
                .all();

            if (index < 0 || index >= records.length) {
                return interaction.editReply("無効な番号");
            }

            await base(AIRTABLE_TABLE).destroy(records[index].id);

            return interaction.editReply("削除しました ✅");
        }

        return interaction.editReply("不明なコマンドです");
    } catch (err) {
        console.error("❌ interaction error:", err);
        try {
            return interaction.editReply("⚠ 内部エラーが発生しました");
        } catch {}
    }
});

console.log("Trying Discord login...");
client.login(TOKEN)
  .then(() => console.log("Login promise resolved"))
  .catch(e => console.error("Login failed:", e));


// ====== HTTP ======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end("Bot running")).listen(PORT);

