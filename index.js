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
const GITHUB_REPO = process.env.GITHUB_REPO;
const EVENTS_PATH = "events.json";

// ===== Discord =====
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// ===== GitHub =====
const ghHeaders = {
    Authorization: `token ${GITHUB_TOKEN}`,
    "User-Agent": "discord-bot",
    Accept: "application/vnd.github+json",
};

// ===== GitHub JSON =====
async function loadEvents() {
    const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${EVENTS_PATH}`,
        { headers: ghHeaders }
    );
    if (res.status === 404) return { events: [], sha: null };
    const data = await res.json();
    const json = Buffer.from(data.content, "base64").toString();
    return { events: JSON.parse(json), sha: data.sha };
}

async function saveEvents(events, sha) {
    await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${EVENTS_PATH}`,
        {
            method: "PUT",
            headers: { ...ghHeaders, "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "update events",
                content: Buffer.from(JSON.stringify(events, null, 2)).toString("base64"),
                sha,
            }),
        }
    );
}

// ===== JST utils（UTC基準・安全）=====
function getJSTNow() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function getJSTDateString() {
    const d = getJSTNow();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function getJSTTodayUTC() {
    const d = getJSTNow();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function daysUntil(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const target = Date.UTC(y, m - 1, d);
    return Math.floor((target - getJSTTodayUTC()) / 86400000);
}

// ===== Core =====
let lastRunDay = null;

async function checkEvents() {
    const today = getJSTDateString();
    if (today === lastRunDay) return;
    lastRunDay = today;

    console.log("⏰ JST 00:00 check:", today);

    let { events, sha } = await loadEvents();
    const channel = await client.channels.fetch(CHANNEL_ID);

    const nextEvents = [];

    for (const e of events) {
        const d = daysUntil(e.date);

        // ✅ 過去イベントは自動削除
        if (d < 0) continue;

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

        nextEvents.push(e);
    }

    await saveEvents(nextEvents, sha);
}

// ===== JST 0:00 安定スケジューラ =====
setInterval(() => {
    const now = getJSTNow();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
        checkEvents();
    }
}, 60 * 1000);

// ===== Slash Commands =====
const commands = [
    new SlashCommandBuilder()
        .setName("addevent")
        .setDescription("イベント追加")
        .addStringOption(o => o.setName("date").setDescription("YYYY-MM-DD").setRequired(true))
        .addStringOption(o => o.setName("message").setDescription("内容").setRequired(true)),
    new SlashCommandBuilder().setName("listevents").setDescription("イベント一覧"),
    new SlashCommandBuilder()
        .setName("deleteevent")
        .setDescription("イベント削除")
        .addIntegerOption(o => o.setName("index").setDescription("番号").setRequired(true)),
    new SlashCommandBuilder().setName("runnow").setDescription("今すぐ実行"),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

// ===== Ready =====
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
    );
});

// ===== Interactions =====
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        await interaction.deferReply();
    } catch (e) {
        console.warn("⚠️ deferReply failed (expired interaction)");
    }

    let { events, sha } = await loadEvents();

    if (interaction.commandName === "runnow") {
        lastRunDay = null;
        await checkEvents();
        return interaction.editReply?.("✅ 実行完了").catch(() => {});
    }

    if (interaction.commandName === "addevent") {
        const newEvent = {
            id: crypto.randomBytes(8).toString("hex"),
            date: interaction.options.getString("date"),
            message: interaction.options.getString("message"),
            n7: false,
            n3: false,
            n0: false,
        };

        events.push(newEvent);
        events.sort((a, b) => a.date.localeCompare(b.date));
        await saveEvents(events, sha);

        return interaction.editReply?.(
            `✅ 追加しました\n📅 ${newEvent.date} - ${newEvent.message}`
        ).catch(() => {});
    }

    if (interaction.commandName === "listevents") {
        if (!events.length) return interaction.editReply("イベントなし");

        // ✅ 表示前に日付ソート
        events.sort((a, b) => a.date.localeCompare(b.date));

        return interaction.editReply(
        events.map((e, i) => `${i + 1}. ${e.date} - ${e.message}`).join("\n")
        );
    }

    if (interaction.commandName === "deleteevent") {
        const index = interaction.options.getInteger("index") - 1;
        if (!events[index])
            return interaction.editReply?.("無効な番号").catch(() => {});
        const removed = events.splice(index, 1)[0];
        await saveEvents(events, sha);
        return interaction.editReply?.(
            `🗑 削除：${removed.date} ${removed.message}`
        ).catch(() => {});
    }
});

// ===== Start =====
client.login(TOKEN);
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);


