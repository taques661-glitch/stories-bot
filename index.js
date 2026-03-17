const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const IG_TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;
const PORT = process.env.PORT || 3001;

const upload = multer({ 
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 }
});

app.use("/uploads", express.static("uploads"));

app.get("/", (req, res) => res.json({ status: "ok", service: "Stories Bot" }));
app.get("/health", (req, res) => res.sendStatus(200));

app.get("/accounts", (req, res) => {
  res.json({ accounts: [{ ig_id: IG_ID, username: "ktsmartsam", followers: 0 }] });
});

async function publishStory(ig_id, mediaUrl, mediaType, token) {
  const isVideo = mediaType === "VIDEO";
  const c = await axios.post(
    "https://graph.instagram.com/v21.0/" + ig_id + "/media?" +
    new URLSearchParams({
      access_token: token,
      media_type: "STORIES",
      [isVideo ? "video_url" : "image_url"]: mediaUrl
    }).toString()
  );
  const creationId = c.data.id;
  console.log("Container:", creationId, "aguardando...");

  if (isVideo) {
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const status = await axios.get(
        "https://graph.instagram.com/v21.0/" + creationId + "?fields=status_code&access_token=" + token
      );
      console.log("Status:", status.data.status_code);
      if (status.data.status_code === "FINISHED") break;
      if (status.data.status_code === "ERROR") throw new Error("Erro no processamento do vídeo");
    }
  } else {
    await sleep(5000);
  }

  const p = await axios.post(
    "https://graph.instagram.com/v21.0/" + ig_id + "/media_publish?" +
    new URLSearchParams({
      creation_id: creationId,
      access_token: token
    }).toString()
  );
  return { media_id: p.data.id };
}

app.post("/stories/publish", upload.single("file"), async (req, res) => {
  const ig_id = req.body.ig_id || IG_ID;
  const token = IG_TOKEN;
  let mediaUrl = req.body.media_url;
  let mediaType = (req.body.media_type || "IMAGE").toUpperCase();

  if (req.file) {
    const host = req.protocol + "://" + req.get("host");
    mediaUrl = host + "/uploads/" + req.file.filename;
    mediaType = req.file.mimetype.includes("video") ? "VIDEO" : "IMAGE";
    console.log("Arquivo recebido:", req.file.originalname, mediaType);
  }

  if (!mediaUrl) return res.status(400).json({ error: "Nenhuma mídia enviada" });

  console.log("Publicando:", mediaUrl, mediaType);
  try {
    const result = await publishStory(ig_id, mediaUrl, mediaType, token);
    console.log("Publicado:", result.media_id);
    res.json({ success: true, media_id: result.media_id });
  } catch (err) {
    console.error("Erro:", err.response?.data || err.message);
    res.status(500).json({ error: "Falha", details: err.response?.data });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Stories Bot rodando na porta " + PORT);
});
