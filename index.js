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
const http = require("http");

// ====== 環境変数チェック ======
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || "1413505791289458799";
const GUILD_ID = process.env.GUILD_ID || "1345978160738730034";

if (!TOKEN) {
    console.error("❌ ERROR: DISCORD_TOKEN が設定されていません。Railway の Variables を確認してください。");
    process.exit(1);
}
if (!CHANNEL_ID) console.warn("⚠ CHANNEL_ID が設定されていません。");
if (!GUILD_ID) console.warn("⚠ GUILD_ID が設定されていません。");

// ====== クライアント ======
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ],
    partials: [Partials.Channel],
});

// イベントファイル
const EVENTS_FILE = path.join(__dirname, "events.json");

// エラーをログに出す
process.on("uncaughtException", err => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", err => console.error("Unhandled Rejection:", err));

// JSONファイルがなければ作成
try {
    if (!fs.existsSync(EVENTS_FILE)) {
        fs.writeFileSync(EVENTS_FILE, "[]");
    }
} catch (err) {
    console.error("❌ events.json 作成に失敗:", err);
}

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
        .addStringOption(opt =>
            opt.setName("date").setDescription("YYYY-MM-DD形式").setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("message").setDescription("通知内容").setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("登録済みイベント一覧"),
    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベントを削除")
        .addIntegerOption(opt =>
            opt.setName("index").setDescription("削除するイベント番号").setRequired(true)
        ),
].map(command => command.toJSON());

// REST準備
const rest = new REST({ version: "10" }).setToken(TOKEN);

// Bot起動時
client.once("ready", async () => {
    console.log(`${client.user.tag} is ready and running on Railway!`);

    // コマンド登録
    try {
        console.log("Refreshing slash commands...");
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, GUILD_ID),
            { body: commands }
        );
        console.log("Slash commands registered!");
    } catch (error) {
        console.error("❌ Slash command registration failed:", error);
    }

    // 毎日0時に通知
    schedule.scheduleJob("0 0 * * *", () => {
        const today = new Date();
        const events = readEvents();

        events.forEach(event => {
            const eventDate = new Date(event.date);
            const diffDays = Math.ceil(
                (eventDate - today) / (1000 * 60 * 60 * 24)
            );

            if ([7, 3, 0].includes(diffDays)) {
                const label =
                    diffDays === 0 ? "本日" :
                    diffDays === 3 ? "3日前" : "7日前";

                const channel = client.channels.cache.get(CHANNEL_ID);
                if (channel) {
                    channel.send(`@everyone ${event.message} (${label})`);
                }
            }
        });
    });
});

// コマンド処理
client.on("interactionCreate", async interaction => {
    if (!interaction.isCommand()) return;

    const events = readEvents();

    if (interaction.commandName === "addevent") {
        const date = interaction.options.getString("date");
        const message = interaction.options.getString("message");

        events.push({ date, message });
        writeEvents(events);

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
            `削除しました ✅\n${removed[0].date} - ${removed[0].message}`
        );
    }
});

// Botログイン
client.login(TOKEN);

// ====== HTTPサーバー追加（スリープ回避用） ======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running ✅");
}).listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});




