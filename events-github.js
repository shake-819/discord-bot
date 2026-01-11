const axios = require("axios");

const OWNER = "shake-819";
const REPO = "discord-bot";
const PATH = "data/events.json";

const API = "https://api.github.com";

async function getFile() {
    try {
        const res = await axios.get(
            `${API}/repos/${OWNER}/${REPO}/contents/${PATH}`,
            {
                headers: {
                    Authorization: `token ${process.env.GITHUB_TOKEN}`
                }
            }
        );
        return res.data;
    } catch {
        return null;
    }
}

async function loadEvents() {
    const file = await getFile();
    if (!file) return [];
    const content = Buffer.from(file.content, "base64").toString();
    return JSON.parse(content);
}

async function saveEvents(events) {
    const file = await getFile();
    const content = Buffer.from(JSON.stringify(events, null, 2)).toString("base64");

    await axios.put(
        `${API}/repos/${OWNER}/${REPO}/contents/${PATH}`,
        {
            message: "Update events",
            content,
            sha: file?.sha
        },
        {
            headers: {
                Authorization: `token ${process.env.GITHUB_TOKEN}`
            }
        }
    );
}

module.exports = { loadEvents, saveEvents };
