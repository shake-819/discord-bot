const {
    Client,
    GatewayIntentBits,
    Partials,
} = require("discord.js");

// ====== 環境変数 ======
const TOKEN = process.env.DISCORD_TOKEN;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;

if (!TOKEN) {
    console.error("❌ DISCORD_TOKEN が未設定");
    process.exit(1);
}
if (!STORAGE_CHANNEL_ID) {
    console.error("❌ STORAGE_CHANNEL_ID が未設定");
    process.exit(1);
}

// ====== クライアント ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
});

// ====== READY（ここが重要） ======
client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    // 保存用チャンネル取得
    const channel = await client.channels.fetch(STORAGE_CHANNEL_ID);

    // Bot自身で保存用メッセージを送信
    const msg = await channel.send("```json\n[]\n```");

    console.log("=================================");
    console.log("STORAGE_MESSAGE_ID =", msg.id);
    console.log("↑ このIDを環境変数に設定して！");
    console.log("=================================");

    // 一度作ったら終了
    process.exit(0);
});

// ====== 起動 ======
client.login(TOKEN);
