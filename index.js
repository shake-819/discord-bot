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
        await new Promise(r => setTimeout(r, 100));
    }
    writing = true;
    try {
        return await fn();
    } finally {
        writing = false;
    }
}

// ====== Discord JSON ストレージ ======
async function readEvents() {
    const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    const message = await channel.messages.fetch(STORAGE_MESSAGE_ID);

    const content = message.content
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();

    try {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) throw new Error("Not array");
        return parsed;
    } catch (err) {
        console.error("❌ JSON parse failed. 書き込み中断", err);
        throw err;
    }
}

async function writeEvents(events) {
    await withWriteLock(async () => {
        const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        const message = await channel.messages.fetch(STORAGE_MESSAGE_ID);

        events.sort((a, b) => new Date(a.date) - new Date(b.date));

        await message.edit(
            "```json\n" +
            JSON.stringify(events, null, 2) +
            "\n```"
        );
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
    schedule.scheduleJob("0 15 * * *", async () => {
        try {
            const now = new Date();
            const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
            const today = new Date(jst.getFullYear(), jst.getMonth(), jst.getDate());

            const events = await readEvents();

            const filtered = events.filter(e => new Date(e.date) >= today);

            if (filtered.length !== events.length) {
                await writeEvents(filtered);
            }

            for (const e of filtered) {
                const diff = Math.ceil(
                    (new Date(e.date) - today) / 86400000
                );

                if ([7, 3, 0].includes(diff)) {
                    const label =
                        diff === 0 ? "本日" :
                        diff === 3 ? "3日前" : "7日前";

                    const ch = client.channels.cache.get(CHANNEL_ID);
                    if (ch) ch.send(`${e.message} (${label})`);
                }
            }
        } catch (err) {
            console.error("❌ 定期処理失敗:", err);
        }
    });
});

// ====== interaction ======
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        if (interaction.commandName === "addevent") {
            await interaction.deferReply();

            const date = interaction.options.getString("date");
            const message = interaction.options.getString("message");

            const events = await readEvents();
            events.push({
                id: crypto.randomUUID(),
                date,
                message
            });

            await writeEvents(events);

            return interaction.editReply(
                `追加しました ✅\n${date} : ${message}`
            );
        }

        if (interaction.commandName === "listevents") {
            const events = await readEvents();

            if (events.length === 0) {
                return interaction.reply("イベントなし");
            }

            return interaction.reply(
                events
                    .map((e, i) => `${i + 1}. ${e.date} - ${e.message}`)
                    .join("\n")
            );
        }

        if (interaction.commandName === "deleteevent") {
            await interaction.deferReply();

            const index = interaction.options.getInteger("index") - 1;
            const events = await readEvents();

            if (index < 0 || index >= events.length) {
                return interaction.editReply("無効な番号");
            }

            const removed = events.splice(index, 1);
            await writeEvents(events);

            return interaction.editReply(
                `削除しました ✅\n${removed[0].date} - ${removed[0].message}`
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


