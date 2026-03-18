process.env.TZ = "America/Manaus";
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dbwdldowa",
  api_key: process.env.CLOUDINARY_API_KEY || "711561261557159",
  api_secret: process.env.CLOUDINARY_API_SECRET || "UfSIUfCFYttXlmw0xTLh3ts50Xs"
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IG_TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;
const PORT = process.env.PORT || 3001;

app.get("/api", (req, res) => res.json({ status: "ok" }));
app.get("/health", (req, res) => res.sendStatus(200));
app.get("/accounts", (req, res) => {
  res.json({ accounts: [{ ig_id: IG_ID, username: "ktsmartsam", followers: 0 }] });
});

async function publishStory(ig_id, mediaUrl, mediaType, token) {
  const isVideo = mediaType === "VIDEO";
  const c = await axios.post(
    "https://graph.instagram.com/v21.0/" + ig_id + "/media?" +
    new URLSearchParams({ access_token: token, media_type: "STORIES", [isVideo ? "video_url" : "image_url"]: mediaUrl }).toString()
  );
  const creationId = c.data.id;
  if (isVideo) {
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const s = await axios.get("https://graph.instagram.com/v21.0/" + creationId + "?fields=status_code&access_token=" + token);
      if (s.data.status_code === "FINISHED") break;
      if (s.data.status_code === "ERROR") throw new Error("Erro no video");
    }
  } else {
    await sleep(5000);
  }
  const p = await axios.post(
    "https://graph.instagram.com/v21.0/" + ig_id + "/media_publish?" +
    new URLSearchParams({ creation_id: creationId, access_token: token }).toString()
  );
  return { media_id: p.data.id };
}

app.post("/stories/publish", upload.single("file"), async (req, res) => {
  const ig_id = req.body.ig_id || IG_ID;
  const token = IG_TOKEN;
  let mediaUrl = req.body.media_url;
  let mediaType = (req.body.media_type || "IMAGE").toUpperCase();

  if (req.file) {
    console.log("Upload recebido:", req.file.originalname, req.file.mimetype);
    mediaType = req.file.mimetype.includes("video") ? "VIDEO" : "IMAGE";
    const resourceType = mediaType === "VIDEO" ? "video" : "image";
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: resourceType, folder: "stories-bot" },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    mediaUrl = result.secure_url;
    console.log("Cloudinary URL:", mediaUrl);
  }

  if (!mediaUrl) return res.status(400).json({ error: "Nenhuma midia enviada" });
  console.log("Publicando:", mediaUrl, mediaType);

  try {
    const result = await publishStory(ig_id, mediaUrl, mediaType, token);
    console.log("Publicado:", result.media_id);
    res.json({ success: true, media_id: result.media_id, media_url: mediaUrl });
  } catch (err) {
    console.error("Erro:", err.response?.data || err.message);
    res.status(500).json({ error: "Falha", details: err.response?.data });
  }
});


const cron = require('node-cron');
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const manaus = new Date(now.toLocaleString('en-US', {timeZone:'America/Manaus'}));
  const dateStr = manaus.getFullYear()+'-'+pad(manaus.getMonth()+1)+'-'+pad(manaus.getDate());
  const timeStr = pad(manaus.getHours())+':'+pad(manaus.getMinutes());
  console.log('Cron:', dateStr, timeStr, 'pending:', scheduled.filter(s=>s.status==='pending').length);
  const toPublish = scheduled.filter(s => s.status==='pending' && s.date===dateStr && s.time===timeStr);
  for(const story of toPublish){
    try{
      await publishStory(story.ig_id||IG_ID, story.url, story.mediaType||'IMAGE', IG_TOKEN);
      story.status='published';
      console.log('Publicado agendado:', story.id);
    }catch(err){story.status='error';console.error('Erro agendado:', err.message);}
  }
  const pending = scheduled.filter(s => s.status==='pending' && s.date===dateStr && s.time===timeStr);
  for(const story of pending){
    try{
      await publishStory(story.ig_id||IG_ID, story.url, story.mediaType||'IMAGE', IG_TOKEN);
      story.status='published';
      console.log('Publicado agendado:', story.id);
    }catch(err){story.status='error';console.error('Erro agendado:', err.message);}
  }
});
app.listen(PORT, "0.0.0.0", () => console.log("Stories Bot porta " + PORT));

// Storage de agendamentos
let scheduled = [];
app.post('/schedule', (req, res) => { scheduled.push({...req.body, status:'pending'}); res.json({success:true}); });
app.get('/schedule', (req, res) => { res.json({scheduled}); });
app.delete('/schedule/:id', (req, res) => { scheduled = scheduled.map(s => s.id==req.params.id?{...s,status:'cancelled'}:s); res.json({success:true}); });
