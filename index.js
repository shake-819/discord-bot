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

// ====== 環境変数 ======
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;



if (!TOKEN || !CHANNEL_ID || !GUILD_ID || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
    console.error("❌ 環境変数が不足しています");
    process.exit(1);
}

// ====== Airtable ======
const base = new Airtable({
    apiKey: AIRTABLE_TOKEN,
}).base(AIRTABLE_BASE_ID);

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
    while (writing) await new Promise(r => setTimeout(r, 50));
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
    const date = new Date(Date.UTC(y, m - 1, d));
    date.setHours(date.getHours() + 9);
    return date;
}

// ====== Airtable ストレージ（旧Discord JSON互換） ======
async function updateEvents(mutator) {
    return await withWriteLock(async () => {
        const records = await base(AIRTABLE_TABLE)
            .select({ sort: [{ field: "date", direction: "asc" }] })
            .all();

        const events = records.map(r => ({
            recordId: r.id,
            id: r.get("id"),
            date: r.get("date"),
            message: r.get("message"),
        }));

        await mutator(events);

        // 新規追加分だけ create
        for (const e of events) {
            if (!e.recordId) {
                await base(AIRTABLE_TABLE).create({
                    id: e.id,
                    date: e.date,
                    message: e.message,
                });
            }
        }

        return events;
    });
}

async function readEventsLocked() {
    return await withWriteLock(async () => {
        const records = await base(AIRTABLE_TABLE)
            .select({ sort: [{ field: "date", direction: "asc" }] })
            .all();

        return records.map(r => ({
            recordId: r.id,
            id: r.get("id"),
            date: r.get("date"),
            message: r.get("message"),
        }));
    });
}

// ====== コマンド定義 ======
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

    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );

    // ====== 毎日 JST 0:00 過去イベント削除 + 通知 ======
    schedule.scheduleJob({ hour: 0, minute: 0, tz: "Asia/Tokyo" }, async () => {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            await updateEvents(async events => {
                for (let i = events.length - 1; i >= 0; i--) {
                    const diff = Math.ceil(
                        (parseJSTDate(events[i].date) - today) / 86400000
                    );

                    if (diff < 0) {
                        await base(AIRTABLE_TABLE).destroy(events[i].recordId);
                        events.splice(i, 1);
                        continue;
                    }

                    if ([7, 3, 0].includes(diff)) {
                        const label =
                            diff === 0 ? "本日" : diff === 3 ? "3日前" : "7日前";
                        const ch = client.channels.cache.get(CHANNEL_ID);
                        if (ch) ch.send(`${events[i].message} (${label})`);
                    }
                }
            });
        } catch (err) {
            console.error("❌ 定期処理失敗:", err);
        }
    });
});

// ====== interaction（二重防止 + atomic） ======
const handledInteractions = new Set();

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (handledInteractions.has(interaction.id)) return;
    handledInteractions.add(interaction.id);
    setTimeout(() => handledInteractions.delete(interaction.id), 60_000);

    try {
        await interaction.deferReply();
    } catch {
        return;
    }

    try {
        if (interaction.commandName === "addevent") {
            const date = interaction.options.getString("date");
            const messageText = interaction.options.getString("message");

            await updateEvents(events => {
                if (!events.some(e => e.date === date && e.message === messageText)) {
                    events.push({
                        id: crypto.randomUUID(),
                        date,
                        message: messageText,
                    });
                }
            });

            return interaction.editReply(`追加しました ✅\n${date} - ${messageText}`);
        }

        if (interaction.commandName === "listevents") {
            const events = await readEventsLocked();
            if (!events.length) return interaction.editReply("イベントなし");

            return interaction.editReply(
                events.map((e, i) => `${i + 1}. ${e.date} - ${e.message}`).join("\n")
            );
        }

        if (interaction.commandName === "deleteevent") {
            const index = interaction.options.getInteger("index") - 1;
            let removed;

            await updateEvents(async events => {
                if (index >= 0 && index < events.length) {
                    removed = events[index];
                    await base(AIRTABLE_TABLE).destroy(removed.recordId);
                    events.splice(index, 1);
                }
            });

            if (!removed) return interaction.editReply("無効な番号");

            return interaction.editReply(
                `削除しました ✅\n${removed.date} - ${removed.message}`
            );
        }

        return interaction.editReply("不明なコマンドです");
    } catch (err) {
        console.error("❌ interaction error:", err);
        try {
            return interaction.editReply("⚠ 内部エラーが発生しました");
        } catch {}
    }
});

// ====== 起動 ======
client.login(TOKEN);

// ====== HTTP ======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.end("Bot running");
}).listen(PORT);

