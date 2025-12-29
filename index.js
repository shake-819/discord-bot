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
    console.error("❌ ERROR: DISCORD_TOKEN が設定されていません。");
    process.exit(1);
}

// ====== クライアント ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// イベントファイル
const EVENTS_FILE = path.join(__dirname, "events.json");

// JSON読み書き
function readEvents() {
    try {
        return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    } catch {
        return [];
    }
}

function writeEvents(events) {
    events.sort((a, b) => new Date(a.date) - new Date(b.date));
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}

// ====== コマンド定義 ======
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("日付とメッセージを追加")
        .addStringOption(o => o.setName("date").setRequired(true))
        .addStringOption(o => o.setName("message").setRequired(true)),
    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("登録済みイベント一覧"),
    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベントを削除")
        .addIntegerOption(o => o.setName("index").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// ====== 起動 ======
client.once("clientReady", async () => {
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );

    // ====== 毎日0時(JST)処理 ======
    schedule.scheduleJob("0 15 * * *", () => {

        const now = new Date();
        const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        const todayJST = new Date(
            jstNow.getFullYear(),
            jstNow.getMonth(),
            jstNow.getDate()
        );

        const events = readEvents();

        // ✅ 過去イベント削除
        const filteredEvents = events.filter(event => {
            const eventDate = new Date(event.date);
            return eventDate >= todayJST;
        });

        if (filteredEvents.length !== events.length) {
            writeEvents(filteredEvents);
        }

        // ✅ 通知
        filteredEvents.forEach(event => {
            const eventDate = new Date(event.date);
            const diffDays = Math.ceil(
                (eventDate - todayJST) / (1000 * 60 * 60 * 24)
            );

            if ([7, 3, 0].includes(diffDays)) {
                const label = diffDays === 0 ? "本日" : `${diffDays}日前`;
                const channel = client.channels.cache.get(CHANNEL_ID);
                channel?.send(`${event.message} (${label})`);
            }
        });
    });
});

// ====== コマンド処理 ======
client.on("interactionCreate", async interaction => {
    if (!interaction.isCommand()) return;

    const events = readEvents();

    if (interaction.commandName === "addevent") {
        events.push({
            date: interaction.options.getString("date"),
            message: interaction.options.getString("message"),
        });
        writeEvents(events);
        interaction.reply("追加しました ✅");
    }

    if (interaction.commandName === "listevents") {
        interaction.reply(
            events.length
                ? events.map((e, i) => `${i + 1}. ${e.date} ${e.message}`).join("\n")
                : "イベントなし"
        );
    }

    if (interaction.commandName === "deleteevent") {
        const i = interaction.options.getInteger("index") - 1;
        if (i < 0 || i >= events.length) return interaction.reply("無効です");
        events.splice(i, 1);
        writeEvents(events);
        interaction.reply("削除しました ✅");
    }
});

client.login(TOKEN);

// ====== HTTP ======
http.createServer((_, res) => {
    res.end("Bot running");
}).listen(process.env.PORT || 3000);

