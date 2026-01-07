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

// ====== 環境変数 ======
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const STORAGE_MESSAGE_ID = process.env.STORAGE_MESSAGE_ID;

if (!TOKEN || !CHANNEL_ID || !GUILD_ID || !STORAGE_CHANNEL_ID || !STORAGE_MESSAGE_ID) {
    console.error("❌ 環境変数が不足しています");
    process.exit(1);
}

// ====== クライアント ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// ====== エラー監視 ======
process.on("uncaughtException", err => console.error("Uncaught:", err));
process.on("unhandledRejection", err => console.error("Unhandled:", err));

// ====== 書き込みロック ======
let writing = false;
async function withWriteLock(fn) {
    while (writing) {
        await new Promise(r => setTimeout(r, 50));
    }
    writing = true;
    try {
        return await fn();
    } finally {
        writing = false;
    }
}

// ====== JST 日付パース ======
function parseJSTDate(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d);
}

// ====== Discord JSON ストレージ（atomic） ======
async function updateEvents(mutator) {
    return await withWriteLock(async () => {
        const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        const message = await channel.messages.fetch(STORAGE_MESSAGE_ID);

        const content = message.content
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

        const events = JSON.parse(content);

        const result = await mutator(events);

        events.sort((a, b) =>
            parseJSTDate(a.date) - parseJSTDate(b.date)
        );

        await message.edit(
            "```json\n" +
            JSON.stringify(events, null, 2) +
            "\n```"
        );

        return result;
    });
}

async function readEventsLocked() {
    return await withWriteLock(async () => {
        const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        const message = await channel.messages.fetch(STORAGE_MESSAGE_ID);

        const content = message.content
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

        return JSON.parse(content);
    });
}

// ====== コマンド定義 ======
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("イベント追加")
        .addStringOption(o =>
            o.setName("date").setDescription("YYYY-MM-DD").setRequired(true)
        )
        .addStringOption(o =>
            o.setName("message").setDescription("内容").setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("イベント一覧"),
    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベント削除")
        .addIntegerOption(o =>
            o.setName("index").setDescription("番号").setRequired(true)
        ),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// ====== READY ======
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );

    // ====== 毎日 JST 0:00 ======
    schedule.scheduleJob(
        { hour: 0, minute: 0, tz: "Asia/Tokyo" },
        async () => {
            try {
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                await updateEvents(events => {
                    const filtered = events.filter(e =>
                        parseJSTDate(e.date) >= today
                    );

                    for (const e of filtered) {
                        const diff = Math.ceil(
                            (parseJSTDate(e.date) - today) / 86400000
                        );

                        if ([7, 3, 0].includes(diff)) {
                            const label =
                                diff === 0 ? "本日" :
                                diff === 3 ? "3日前" : "7日前";

                            const ch = client.channels.cache.get(CHANNEL_ID);
                            if (ch) ch.send(`${e.message} (${label})`);
                        }
                    }

                    events.length = 0;
                    events.push(...filtered);
                });
            } catch (err) {
                console.error("❌ 定期処理失敗:", err);
            }
        }
    );
});


// ====== interaction（二重防止・完全版） ======
const handledInteractions = new Set();

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // 二重実行防止
    if (handledInteractions.has(interaction.id)) return;
    handledInteractions.add(interaction.id);
    setTimeout(() => handledInteractions.delete(interaction.id), 60_000);

    try {
        // ====== add ======
        if (interaction.commandName === "addevent") {
            await interaction.deferReply();

            const date = interaction.options.getString("date");
            const message = interaction.options.getString("message");

            await updateEvents(events => {
                events.push({
                    id: crypto.randomUUID(),
                    date,
                    message
                });
            });

            return interaction.editReply(
                `追加しました ✅\n${date} - ${message}`
            );
        }

        // ====== list ======
        if (interaction.commandName === "listevents") {
            const events = await updateEvents(events => events);

            if (!events || events.length === 0) {
                return interaction.reply("イベントなし");
            }

            return interaction.reply(
                events
                    .map((e, i) => `${i + 1}. ${e.date} - ${e.message}`)
                    .join("\n")
            );
        }

        // ====== delete（index 削除） ======
        if (interaction.commandName === "deleteevent") {
            await interaction.deferReply();

            const index = interaction.options.getInteger("index") - 1;

            const removed = await updateEvents(events => {
                if (index < 0 || index >= events.length) return null;
                return events.splice(index, 1)[0];
            });

            if (!removed) {
                return interaction.editReply("無効な番号");
            }

            return interaction.editReply(
                `削除しました ✅\n${removed.date} - ${removed.message}`
            );
        }
    } catch (err) {
        console.error("❌ interaction error:", err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply("⚠ 内部エラーが発生しました");
        }
    }
});


// ====== 起動 ======
client.login(TOKEN);

// ====== HTTP ======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.end("Bot running");
}).listen(PORT);

