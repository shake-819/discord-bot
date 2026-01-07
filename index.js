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

// ====== Discord JSON ストレージ（atomic & force fetch） ======
async function updateEvents(mutator) {
    return await withWriteLock(async () => {
        const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        const message = await channel.messages.fetch(STORAGE_MESSAGE_ID, { force: true });

        let content = message.content
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/i, "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .trim();

        const events = JSON.parse(content || "[]");

        await mutator(events); // ★ mutate はここで一括

        events.sort((a, b) => parseJSTDate(a.date) - parseJSTDate(b.date));

        await message.edit("```json\n" + JSON.stringify(events, null, 2) + "\n```");

        return events;
    });
}

async function readEventsLocked() {
    return await withWriteLock(async () => {
        const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);
        const message = await channel.messages.fetch(STORAGE_MESSAGE_ID, { force: true });

        let content = message.content
            .replace(/^```json\s*/i, "")
            .replace(/\s*```$/i, "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .trim();

        try {
            return JSON.parse(content || "[]");
        } catch (e) {
            console.error("⚠ JSON parse failed:", e, "content:", content);
            return [];
        }
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

    // ====== 毎日 JST 0:00 過去イベント削除（安全化） ======
    schedule.scheduleJob({ hour: 0, minute: 0, tz: "Asia/Tokyo" }, async () => {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            await updateEvents(events => {
                // 過去イベントだけを安全に削除
                for (let i = events.length - 1; i >= 0; i--) {
                    if (parseJSTDate(events[i].date) < today) {
                        events.splice(i, 1);
                    }
                }

                // 7日・3日・0日前通知
                for (const e of events) {
                    const diff = Math.ceil((parseJSTDate(e.date) - today) / 86400000);
                    if ([7, 3, 0].includes(diff)) {
                        const label = diff === 0 ? "本日" : diff === 3 ? "3日前" : "7日前";
                        const ch = client.channels.cache.get(CHANNEL_ID);
                        if (ch) ch.send(`${e.message} (${label})`);
                    }
                }
            });
        } catch (err) {
            console.error("❌ 定期処理失敗:", err);
        }
    });
});

// ====== interaction（二重防止 + atomic + 重複防止） ======
const handledInteractions = new Set();

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // 二重押し防止
    if (handledInteractions.has(interaction.id)) return;
    handledInteractions.add(interaction.id);
    setTimeout(() => handledInteractions.delete(interaction.id), 60_000);

    try {
        await interaction.deferReply();
    } catch {
        return;
    }

    try {
        // ====== add event ======
        if (interaction.commandName === "addevent") {
            const date = interaction.options.getString("date");
            const messageText = interaction.options.getString("message");

            await updateEvents(events => {
                // 重複防止: 同じ日付・内容は追加しない
                if (!events.some(e => e.date === date && e.message === messageText)) {
                    events.push({ id: crypto.randomUUID(), date, message: messageText });
                }
            });

            return interaction.editReply(`追加しました ✅\n${date} - ${messageText}`);
        }

        // ====== list events ======
        if (interaction.commandName === "listevents") {
            // ★ 常に最新の Discord メッセージから取得
            const events = await readEventsLocked();
            if (!events || events.length === 0) return interaction.editReply("イベントなし");

            return interaction.editReply(
                events.map((e, i) => `${i + 1}. ${e.date} - ${e.message}`).join("\n")
            );
        }

        // ====== delete event ======
        if (interaction.commandName === "deleteevent") {
            const index = interaction.options.getInteger("index") - 1;
            let removed;
            await updateEvents(events => {
                if (index >= 0 && index < events.length) removed = events.splice(index, 1)[0];
            });

            if (!removed) return interaction.editReply("無効な番号");

            return interaction.editReply(`削除しました ✅\n${removed.date} - ${removed.message}`);
        }

        return interaction.editReply("不明なコマンドです");
    } catch (err) {
        console.error("❌ interaction error:", err);
        try { return interaction.editReply("⚠ 内部エラーが発生しました"); } catch {}
    }
});


// ====== 起動 ======
client.login(TOKEN);

// ====== HTTP ======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.end("Bot running"); }).listen(PORT);

