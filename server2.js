const express = require("express");
const axios = require("axios");
const fs = require("fs");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readDB() {
  return JSON.parse(fs.readFileSync("/Users/kevintaques/stories-bot/backend/db.json"));
}

app.get("/accounts", (req, res) => {
  const db = readDB();
  res.json({ accounts: Object.values(db.accounts) });
});

app.post("/stories/publish", async (req, res) => {
  const { ig_id, media_url } = req.body;
  console.log("Publicando:", media_url);
  const db = readDB();
  const account = db.accounts[ig_id];
  if (!account) return res.status(404).json({ error: "Conta nao encontrada" });
  try {
    const c = await axios.post(
      "https://graph.instagram.com/v21.0/" + ig_id + "/media?" +
      new URLSearchParams({ access_token: account.page_token, media_type: "STORIES", image_url: media_url }).toString()
    );
    console.log("Container:", c.data.id, "aguardando 5s...");
    await sleep(5000);
    const p = await axios.post(
      "https://graph.instagram.com/v21.0/" + ig_id + "/media_publish?" +
      new URLSearchParams({ creation_id: c.data.id, access_token: account.page_token }).toString()
    );
    console.log("Publicado:", p.data.id);
    res.json({ success: true, media_id: p.data.id });
  } catch (err) {
    console.error("Erro:", err.response?.data);
    res.status(500).json({ error: "Falha", details: err.response?.data });
  }
});

app.listen(3001, () => console.log("Stories Bot porta 3001 - OK"));
setTimeout(() => {}, 999999999);
