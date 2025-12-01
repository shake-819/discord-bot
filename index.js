const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");

// ボット設定
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1413505791289458799"; // 通知チャンネルID
const GUILD_ID = "1345978160738730034"; // サーバー専用コマンド用
const EVENTS_FILE = path.join(__dirname, "events.json"); // 絶対パス指定

process.on("uncaughtException", console.error);
process.on("unhandledRejection", console.error);

// JSONファイルがなければ作成
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "[]");

// JSON読み書き関数
function readEvents() {
    try {
        return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    } catch (err) {
        console.error("Failed to read events.json:", err);
        return [];
    }
}

function writeEvents(events) {
    try {
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
        console.log("events.json updated!");
    } catch (err) {
        console.error("Failed to write events.json:", err);
    }
}

// コマンド定義
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("日付とメッセージを追加")
        .addStringOption((opt) =>
            opt
                .setName("date")
                .setDescription("YYYY-MM-DD形式")
                .setRequired(true),
        )
        .addStringOption((opt) =>
            opt.setName("message").setDescription("通知内容").setRequired(true),
        ),

    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("登録済みイベント一覧"),

    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベントを削除")
        .addIntegerOption((opt) =>
            opt
                .setName("index")
                .setDescription("削除するイベント番号")
                .setRequired(true),
        ),
].map((command) => command.toJSON());

// REST準備
const rest = new REST({ version: "10" }).setToken(TOKEN);

// Bot起動時
client.once("ready", async () => {
    console.log(`${client.user.tag} is ready!`);

    // サーバー専用コマンド登録
    try {
        console.log("Refreshing slash commands for guild...");
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands },
        );
        console.log("Guild slash commands registered!");
    } catch (error) {
        console.error(error);
    }

    // 毎日0時に通知
    schedule.scheduleJob("0 0 * * *", () => {
        const today = new Date();
        const events = readEvents();

        events.forEach((event) => {
            const eventDate = new Date(event.date);
            const diffDays = Math.ceil(
                (eventDate - today) / (1000 * 60 * 60 * 24),
            );

            if (diffDays === 7 || diffDays === 3 || diffDays === 0) {
                const label =
                    diffDays === 0
                        ? "本日"
                        : diffDays === 3
                          ? "3日前"
                          : "7日前";
                const channel = client.channels.cache.get(CHANNEL_ID);
                if (channel) {
                    channel.send(`@everyone ${event.message} (${label})`);
                }
            }
        });
    });
});

// コマンド処理
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) return;

    const events = readEvents();

    if (interaction.commandName === "addevent") {
        const date = interaction.options.getString("date");
        const message = interaction.options.getString("message");

        events.push({ date, message });
        writeEvents(events);

        console.log("Added event:", { date, message });

        await interaction.reply(`イベント追加 ✅\n${date} : ${message}`);
    }

    if (interaction.commandName === "listevents") {
        if (events.length === 0)
            return interaction.reply("登録されているイベントはありません。");
        const list = events
            .map((e, i) => `${i + 1}. ${e.date} - ${e.message}`)
            .join("\n");
        await interaction.reply(`📅 登録イベント一覧:\n${list}`);
    }

    if (interaction.commandName === "deleteevent") {
        const index = interaction.options.getInteger("index") - 1;
        if (index < 0 || index >= events.length)
            return interaction.reply("無効な番号です。");
        const removed = events.splice(index, 1);
        writeEvents(events);
        await interaction.reply(
            `削除しました ✅\n${removed[0].date} - ${removed[0].message}`,
        );
    }
});

// Botログイン
client.login(TOKEN);
