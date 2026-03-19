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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IG_TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_ID;
const PORT = process.env.PORT || 3001;

// SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL || "https://uhayvtncounslqlchtpz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYXl2dG5jb3Vuc2xxbGNodHB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNzk2NTksImV4cCI6MjA4ODc1NTY1OX0.E7HLAXBChvUeEhxi-Dp1TryIOfQN4P1Na4egj09KSpA";

const sbHeaders = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Prefer": "return=representation"
};

async function sbGet(query = "") {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/stories_tfx?${query}&order=date.asc,time.asc`, { headers: sbHeaders });
  return r.data;
}
async function sbUpsert(story) {
  const row = {
    id: story.id,
    ig_id: story.ig_id || IG_ID,
    url: story.url,
    date: story.date,
    time: story.time,
    caption: story.caption || "",
    status: story.status || "scheduled",
    media_type: story.mediaType || story.media_type || "IMAGE",
    repeat_rule: story.repeat || "none",
    link: story.link || ""
  };
  await axios.post(`${SUPABASE_URL}/rest/v1/stories_tfx`, row, {
    headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=representation" }
  });
}
async function sbUpdate(id, fields) {
  await axios.patch(`${SUPABASE_URL}/rest/v1/stories_tfx?id=eq.${id}`, fields, { headers: sbHeaders });
}
async function sbDelete(id) {
  await axios.delete(`${SUPABASE_URL}/rest/v1/stories_tfx?id=eq.${id}`, { headers: sbHeaders });
}

// FIX: garante URL limpa do Cloudinary (sem transformações que o Instagram rejeita)
function cleanCloudinaryUrl(url) {
  if (!url || !url.includes('cloudinary.com')) return url;
  // Remove qualquer segmento de transformação entre /upload/ e o nome do arquivo
  return url.replace(/\/upload\/[^/]+\/v/, '/upload/v');
}

// FIX: polling mais robusto para vídeo — 60 tentativas × 5s = 5 minutos
async function waitForVideo(containerId, token) {
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const statusRes = await axios.get(
      `https://graph.facebook.com/v19.0/${containerId}?fields=status_code,status&access_token=${token}`
    );
    const code = statusRes.data.status_code;
    console.log(`[Vídeo] tentativa ${i+1}/60 — status: ${code}`);
    if (code === 'FINISHED') return true;
    if (code === 'ERROR') {
      const detail = statusRes.data.status || 'sem detalhes';
      throw new Error(`Instagram rejeitou o vídeo: ${detail}`);
    }
  }
  throw new Error('Timeout: vídeo não processou em 5 minutos');
}

app.get("/api", (req, res) => res.json({ status: "ok" }));
app.get("/health", (req, res) => res.sendStatus(200));
app.get("/accounts", (req, res) => {
  res.json({ accounts: [{ ig_id: IG_ID, username: "ktsmartsam", followers: 0 }] });
});

// GET stories from Supabase
app.get("/schedule", async (req, res) => {
  try {
    const rows = await sbGet("select=*");
    const stories = rows.map(r => ({
      id: r.id,
      ig_id: r.ig_id,
      url: r.url,
      date: r.date,
      time: r.time,
      caption: r.caption,
      status: r.status,
      mediaType: r.media_type,
      repeat: r.repeat_rule,
      link: r.link || ""
    }));
    res.json({ stories });
  } catch (e) {
    console.error("sbGet error:", e.message);
    res.json({ stories: [] });
  }
});

// POST - save story to Supabase
app.post("/schedule", async (req, res) => {
  try {
    await sbUpsert(req.body);
    res.json({ success: true });
  } catch (e) {
    console.error("sbUpsert error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// PATCH - update story
app.patch("/schedule/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const fields = {};
    if (req.body.status) fields.status = req.body.status;
    if (req.body.date) fields.date = req.body.date;
    if (req.body.time) fields.time = req.body.time;
    if (req.body.caption !== undefined) fields.caption = req.body.caption;
    if (req.body.url) fields.url = req.body.url;
    if (req.body.link !== undefined) fields.link = req.body.link;
    if (req.body.mediaType) fields.media_type = req.body.mediaType;
    await sbUpdate(id, fields);
    res.json({ success: true });
  } catch (e) {
    console.error("sbUpdate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE story
app.delete("/schedule/:id", async (req, res) => {
  try {
    await sbDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error("sbDelete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// UPLOAD to Cloudinary — uploads agora vão direto ao Cloudinary pelo frontend
// Esta rota é mantida apenas para compatibilidade
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const isVideo = req.file.mimetype.startsWith("video");
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: isVideo ? "video" : "image", folder: "stories_tfx", format: isVideo ? "mp4" : undefined },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });
    const cleanUrl = cleanCloudinaryUrl(result.secure_url);
    res.json({ url: cleanUrl, mediaType: isVideo ? "VIDEO" : "IMAGE" });
  } catch (e) {
    console.error("Upload error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUBLISH story to Instagram
app.post("/stories/publish", upload.single("file"), async (req, res) => {
  try {
    const token = IG_TOKEN;
    const igId = req.body?.ig_id || IG_ID;
    let mediaUrl = req.body?.media_url;
    let mediaType = req.body?.media_type || "IMAGE";

    if (req.file) {
      const isVideo = req.file.mimetype.startsWith("video");
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: isVideo ? "video" : "image",
            folder: "stories_tfx",
            ...(isVideo ? {
              format: "mp4",
              eager: [{ fetch_format: "mp4", quality: "auto:good", bit_rate: "2m", width: 1080, height: 1920, crop: "limit" }],
              eager_async: true
            } : {})
          },
          (err, r) => err ? reject(err) : resolve(r)
        );
        stream.end(req.file.buffer);
      });
      mediaUrl = cleanCloudinaryUrl(result.secure_url);
      mediaType = isVideo ? "VIDEO" : "IMAGE";
    }

    if (!mediaUrl) return res.status(400).json({ error: "No media URL" });

    // FIX: limpa URL antes de enviar ao Instagram
    mediaUrl = cleanCloudinaryUrl(mediaUrl);

    const isVideo = mediaType === "VIDEO";
    console.log(`Publicando ${isVideo ? 'VÍDEO' : 'IMAGEM'}: ${mediaUrl}`);

    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${igId}/media`,
      {
        [isVideo ? "video_url" : "image_url"]: mediaUrl,
        media_type: "STORIES",
        access_token: token
      }
    );
    const containerId = containerRes.data.id;
    console.log(`Container criado: ${containerId}`);

    if (isVideo) {
      // Responde imediatamente — publica em background para evitar timeout do Render
      res.json({ success: true, processing: true });
      try {
        await waitForVideo(containerId, token);
        await axios.post(
          `https://graph.facebook.com/v19.0/${igId}/media_publish`,
          { creation_id: containerId, access_token: token }
        );
        console.log(`Vídeo publicado com sucesso em background!`);
      } catch (bgErr) {
        console.error(`Erro ao publicar vídeo em background:`, bgErr.response?.data || bgErr.message);
      }
    } else {
      await sleep(3000);
      await axios.post(
        `https://graph.facebook.com/v19.0/${igId}/media_publish`,
        { creation_id: containerId, access_token: token }
      );
      console.log(`Imagem publicada com sucesso!`);
      res.json({ success: true });
    }
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error("Publish error:", errMsg, e.response?.data || '');
    res.status(500).json({ error: errMsg });
  }
});

// Cleanup removido — status 'publishing' não suportado pelo Supabase

// ROTA chamada pelo cron-job.org a cada minuto — acorda o servidor E publica
app.get("/publish-due", async (req, res) => {
  res.sendStatus(200); // responde imediatamente para não dar timeout
  try {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const times = [];
    for(let i = 0; i <= 3; i++) {
      const t = new Date(now - i * 60000);
      times.push(t.toTimeString().substring(0, 5));
    }
    const allRows = [];
    for(const t of times) {
      const r = await sbGet(`status=eq.scheduled&date=eq.${dateStr}&time=eq.${t}`);
      allRows.push(...r);
    }
    const seen = new Set();
    const rows = allRows.filter(r => { if(seen.has(r.id)) return false; seen.add(r.id); return true; });
    console.log(`[publish-due] ${rows.length} stories para publicar`);
    for (const row of rows) {
      if (!row.url || row.url.includes("[arquivo")) continue;
      await sbUpdate(row.id, { status: "publishing" });
      try {
        const isVideo = row.media_type === "VIDEO";
        let mediaUrl = cleanCloudinaryUrl(row.url);
        if(isVideo && mediaUrl.includes('cloudinary.com') && !mediaUrl.endsWith('.mp4')){
          mediaUrl = mediaUrl.replace(/\.[^.]+$/, '.mp4');
        }
        console.log(`[publish-due] Publicando ${row.id} — ${isVideo ? 'VÍDEO' : 'IMAGEM'}`);
        const containerRes = await axios.post(
          `https://graph.facebook.com/v19.0/${row.ig_id || IG_ID}/media`,
          { [isVideo ? "video_url" : "image_url"]: mediaUrl, media_type: "STORIES", access_token: IG_TOKEN }
        );
        const containerId = containerRes.data.id;
        if (isVideo) {
          await waitForVideo(containerId, IG_TOKEN);
        } else {
          await sleep(3000);
        }
        await axios.post(
          `https://graph.facebook.com/v19.0/${row.ig_id || IG_ID}/media_publish`,
          { creation_id: containerId, access_token: IG_TOKEN }
        );
        await sbUpdate(row.id, { status: "published" });
        console.log(`[publish-due] Story ${row.id} publicado!`);
      } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        console.error(`[publish-due] Falha story ${row.id}:`, errMsg);
        await sbUpdate(row.id, { status: "error" });
      }
    }
  } catch(e) {
    console.error("[publish-due] Erro:", e.message);
  }
});

// Cron interno removido — publicação feita via /publish-due chamado pelo cron-job.org a cada minuto

app.listen(PORT, () => console.log(`Stories TFX rodando na porta ${PORT}`));
