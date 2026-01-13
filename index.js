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

const http = require("http");
const crypto = require("crypto");
const fetch = require("node-fetch");

console.log("BOOT START");

// ===== ENV =====
const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // username/repo
const EVENTS_PATH = "events.json";

// ===== Discord =====
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// ===== GitHub API =====
const ghHeaders = {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "User-Agent": "discord-bot",
    "Accept": "application/vnd.github+json"
};

async function loadEvents() {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${EVENTS_PATH}`, {
        headers: ghHeaders
    });
    if (res.status === 404) return { events: [], sha: null };

    const data = await res.json();
    const json = Buffer.from(data.content, "base64").toString();
    return { events: JSON.parse(json), sha: data.sha };
}

async function saveEvents(events, sha) {
    const body = {
        message: "update events",
        content: Buffer.from(JSON.stringify(events, null, 2)).toString("base64"),
        sha
    };

    await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${EVENTS_PATH}`, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}

// ===== JST utils (safe) =====
function getJSTToday() {
    const now = new Date();
    const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    jst.setHours(0, 0, 0, 0);
    return jst;
}

function getJSTDateString() {
    const now = new Date();
    const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    return (
        jst.getFullYear() + "-" +
        String(jst.getMonth() + 1).padStart(2, "0") + "-" +
        String(jst.getDate()).padStart(2, "0")
    );
}

function daysUntil(dateStr) {
    const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return NaN;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const target = new Date(y, mo, d);
    const today = getJSTToday();
    return Math.floor((target - today) / 86400000);
}

// ===== Slash Commands =====
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("イベント追加")
        .addStringOption(o => o.setName("date").setDescription("YYYY-MM-DD or YYYY-M-D").setRequired(true))
        .addStringOption(o => o.setName("message").setDescription("内容").setRequired(true)),

    new SlashCommandBuilder()
        .setName("listevents")
        .setDescription("イベント一覧"),

    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベント削除")
        .addIntegerOption(o => o.setName("index").setDescription("番号").setRequired(true)),

    new SlashCommandBuilder()
        .setName("runnow")
        .setDescription("今すぐリマインダー処理を実行"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// ===== READY =====
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );
    setInterval(checkEvents, 60 * 1000);
});

// ===== Scheduler =====
let lastRunDay = null;

// ===== Core =====
async function checkEvents() {
    const today = getJSTDateString();
    if (today === lastRunDay) return;
    lastRunDay = today;

    console.log("⏰ Daily check:", today);

    const { events, sha } = await loadEvents();

    let channel;
    try {
        channel = await client.channels.fetch(CHANNEL_ID);
    } catch (e) {
        console.error("Channel fetch failed:", e);
        return;
    }

    const newEvents = [];

    for (const e of events) {
        const d = daysUntil(e.date);
        if (d < 0) continue;

        if (d === 7 && !e.n7) {
            try { await channel.send(`📅【7日前】${e.date} - ${e.message}`); } catch {}
            e.n7 = true;
        }
        if (d === 3 && !e.n3) {
            try { await channel.send(`📅【3日前】${e.date} - ${e.message}`); } catch {}
            e.n3 = true;
        }
        if (d === 0 && !e.n0) {
            try { await channel.send(`📅【今日】${e.date} - ${e.message}`); } catch {}
            e.n0 = true;
        }
        newEvents.push(e);
    }

    await saveEvents(newEvents, sha);
}

// ===== Commands =====
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // interaction寿命に依存しないACK
    try {
        await interaction.reply({ content: "⏳ 実行中...", flags: 64 });
    } catch {}

    try {
        let { events, sha } = await loadEvents();

        function sortEventsByDate(events) {
            return events.sort((a, b) => daysUntil(a.date) - daysUntil(b.date));
        }

        if (interaction.commandName === "runnow") {
            lastRunDay = null;
            checkEvents()
                .then(async () => {
                    const ch = await client.channels.fetch(CHANNEL_ID);
                    ch.send("✅ /runnow による通知チェックが完了しました");
                })
                .catch(async e => {
                    const ch = await client.channels.fetch(CHANNEL_ID);
                    ch.send("❌ /runnow エラー: " + e.message);
                });
            return;
        }

        if (interaction.commandName === "addevent") {
            const date = interaction.options.getString("date");
            const message = interaction.options.getString("message");

            events.push({
                id: crypto.randomBytes(8).toString("hex"),
                date,
                message,
                n7: false,
                n3: false,
                n0: false
            });
            await saveEvents(events, sha);
            return interaction.followUp({ content: `追加しました ✅\n📅 ${date} ${message}`, flags: 64 });
        }

        if (interaction.commandName === "listevents") {
            if (!events.length) return interaction.followUp({ content: "イベントはありません", flags: 64 });
            const sorted = sortEventsByDate(events);
            return interaction.followUp({
                content: sorted.map((e, i) => `${i + 1}. ${e.date} - ${e.message}`).join("\n"),
                flags: 64
            });
        }

        if (interaction.commandName === "deleteevent") {
            const index = interaction.options.getInteger("index") - 1;
            const sorted = sortEventsByDate(events);
            if (index < 0 || index >= sorted.length) {
                return interaction.followUp({ content: "無効な番号です", flags: 64 });
            }
            const removed = sorted[index];
            events = events.filter(e => e.id !== removed.id);
            await saveEvents(events, sha);
            return interaction.followUp({ content: `削除しました 🗑\n📅 ${removed.date} ${removed.message}`, flags: 64 });
        }

    } catch (err) {
        console.error("interaction error:", err);
    }
});

// ===== Start =====
console.log("Trying Discord login...");
client.login(TOKEN);

// ===== HTTP keep alive =====
http.createServer((req, res) => res.end("OK"))
    .listen(process.env.PORT || 3000);




