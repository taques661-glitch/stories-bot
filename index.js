const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const IG_TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;

app.get("/accounts", (req, res) => {
  res.json({ accounts: [{ ig_id: IG_ID, username: "ktsmartsam", followers: 0 }] });
});

app.post("/stories/publish", async (req, res) => {
  const { media_url } = req.body;
  const ig_id = req.body.ig_id || IG_ID;
  const token = IG_TOKEN;
  console.log("Publicando:", media_url);
  try {
    const c = await axios.post(
      "https://graph.instagram.com/v21.0/" + ig_id + "/media?" +
      new URLSearchParams({ access_token: token, media_type: "STORIES", image_url: media_url }).toString()
    );
    console.log("Container:", c.data.id, "aguardando 5s...");
    await sleep(5000);
    const p = await axios.post(
      "https://graph.instagram.com/v21.0/" + ig_id + "/media_publish?" +
      new URLSearchParams({ creation_id: c.data.id, access_token: token }).toString()
    );
    console.log("Publicado:", p.data.id);
    res.json({ success: true, media_id: p.data.id });
  } catch (err) {
    console.error("Erro:", err.response?.data);
    res.status(500).json({ error: "Falha", details: err.response?.data });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("Stories Bot rodando na porta " + PORT));
