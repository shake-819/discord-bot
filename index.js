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

// ===== JST utils =====
function getJSTToday() {
    const d = new Date(Date.now() + 9 * 3600000);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

function daysUntil(dateStr) {
    const today = getJSTToday();
    const target = new Date(dateStr + "T00:00:00+09:00");
    return Math.floor((target - today) / 86400000);
}

// ===== Slash Commands =====
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

// ===== READY =====
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );

    scheduleDaily();
});

// ===== Scheduler =====
function scheduleDaily() {
    setInterval(checkEvents, 60 * 1000); // 毎分 0:00判定
}

let lastRun = null;

async function checkEvents() {
    const now = new Date(Date.now() + 9 * 3600000);
    if (now.getUTCHours() !== 0) return;

    const today = now.toDateString();
    if (lastRun === today) return;
    lastRun = today;

    const { events, sha } = await loadEvents();
    const channel = await client.channels.fetch(CHANNEL_ID);

    const newEvents = [];

    for (const e of events) {
        const d = daysUntil(e.date);

        if (d < 0) continue; // 期限切れ → 削除

        if (d === 7 && !e.n7) {
            await channel.send(`📅【7日前】${e.date} - ${e.message}`);
            e.n7 = true;
        }

        if (d === 3 && !e.n3) {
            await channel.send(`📅【3日前】${e.date} - ${e.message}`);
            e.n3 = true;
        }

        if (d === 0 && !e.n0) {
            await channel.send(`📅【今日】${e.date} - ${e.message}`);
            e.n0 = true;
        }

        newEvents.push(e);
    }

    await saveEvents(newEvents, sha);
}

// ===== Interactions =====
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply();

    const { events, sha } = await loadEvents();

    if (interaction.commandName === "addevent") {
        events.push({
            id: crypto.randomBytes(8).toString("hex"),
            date: interaction.options.getString("date"),
            message: interaction.options.getString("message"),
            n7: false, n3: false, n0: false
        });

        await saveEvents(events, sha);
        await interaction.editReply("追加しました ✅");
    }

    if (interaction.commandName === "listevents") {
        if (!events.length) return interaction.editReply("なし");

        await interaction.editReply(
            events.map((e, i) => `${i+1}. ${e.date} - ${e.message}`).join("\n")
        );
    }

    if (interaction.commandName === "deleteevent") {
        const i = interaction.options.getInteger("index") - 1;
        events.splice(i, 1);
        await saveEvents(events, sha);
        await interaction.editReply("削除しました");
    }
});

// ===== Start =====
console.log("Trying Discord login...");
client.login(TOKEN);

// ===== HTTP =====
http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 3000);
