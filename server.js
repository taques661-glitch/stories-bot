const express = require("express");
const axios = require("axios");
const multer = require("multer");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static("uploads"));

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  APP_ID: "1582120259748107",
  APP_SECRET: "a11489728bf4dd8b3cac40b74b9d1537",
  REDIRECT_URI: process.env.REDIRECT_URI || "https://devon-subfusiform-weedily.ngrok-free.dev/auth/callback",
  GRAPH_API: "https://graph.instagram.com/v19.0",
  PORT: process.env.PORT || 3000,
};

// ─── STORAGE (em produção, use banco de dados real) ─────────────────────────
const DB_FILE = "./db.json";

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ accounts: {}, scheduled: [], history: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── UPLOAD DE MÍDIA ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "video/mp4", "video/quicktime"];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// 1. Redirecionar para login da Meta
app.get("/auth/login", (req, res) => {
  const scopes = [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
  ].join(",");

  const url =
    `https://api.instagram.com/oauth/authorize?` +
    `client_id=${CONFIG.APP_ID}` +
    `&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}` +
    `&scope=${scopes}` +
    `&response_type=code`;

  res.json({ auth_url: url });
});

// 2. Callback OAuth - trocar code por token
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "Code não recebido" });

  try {
    // Trocar code por access token
    const tokenRes = await axios.post("https://api.instagram.com/oauth/access_token", new URLSearchParams({ client_id: CONFIG.APP_ID, client_secret: CONFIG.APP_SECRET, grant_type: "authorization_code", redirect_uri: CONFIG.REDIRECT_URI, code }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });

    const { access_token } = tokenRes.data;

    // Buscar contas do Instagram Business vinculadas
    const pagesRes = await axios.get(`${CONFIG.GRAPH_API}/me/accounts`, {
      params: { access_token, fields: "id,name,access_token,instagram_business_account" },
    });

    const db = readDB();
    const accounts = [];

    for (const page of pagesRes.data.data) {
      if (page.instagram_business_account) {
        const igRes = await axios.get(
          `${CONFIG.GRAPH_API}/${page.instagram_business_account.id}`,
          {
            params: {
              fields: "id,username,profile_picture_url,followers_count",
              access_token: page.access_token,
            },
          }
        );

        const account = {
          ig_id: igRes.data.id,
          username: igRes.data.username,
          profile_picture: igRes.data.profile_picture_url,
          followers: igRes.data.followers_count,
          page_token: page.access_token,
          connected_at: new Date().toISOString(),
        };

        db.accounts[igRes.data.id] = account;
        accounts.push(account);
      }
    }

    writeDB(db);
    res.json({ success: true, accounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Falha na autenticação", details: err.response?.data });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ACCOUNTS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get("/accounts", (req, res) => {
  const db = readDB();
  const accounts = Object.values(db.accounts).map((a) => ({
    ig_id: a.ig_id,
    username: a.username,
    profile_picture: a.profile_picture,
    followers: a.followers,
    connected_at: a.connected_at,
  }));
  res.json({ accounts });
});

app.delete("/accounts/:ig_id", (req, res) => {
  const db = readDB();
  delete db.accounts[req.params.ig_id];
  writeDB(db);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// STORIES - PUBLICAR AGORA
// ══════════════════════════════════════════════════════════════════════════════

async function publishStory(ig_id, mediaUrl, mediaType, sticker = null) {
  const db = readDB();
  const account = db.accounts[ig_id];
  if (!account) throw new Error("Conta não encontrada"); console.log("TOKEN:", account.page_token.substring(0, 30));
  const isVideo = mediaType === "VIDEO";
  const params = new URLSearchParams({
    access_token: account.page_token,
    media_type: "STORIES",
    [isVideo ? "video_url" : "image_url"]: mediaUrl,
  });
  const containerRes = await axios.post(
    `https://graph.instagram.com/v21.0/${ig_id}/media?${params.toString()}`
  );
  const creationId = containerRes.data.id;
  const publishParams = new URLSearchParams({
    creation_id: creationId,
    access_token: account.page_token,
  });
  const publishRes = await axios.post(
    `https://graph.instagram.com/v21.0/${ig_id}/media_publish?${publishParams.toString()}`
  );
  return { media_id: publishRes.data.id };
}

async function waitForMediaReady(ig_id, creation_id, token, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const statusRes = await axios.get(`${CONFIG.GRAPH_API}/${creation_id}`, {
      params: { fields: "status_code", access_token: token },
    });
    if (statusRes.data.status_code === "FINISHED") return true;
    if (statusRes.data.status_code === "ERROR") throw new Error("Erro no processamento do vídeo");
  }
  throw new Error("Timeout aguardando processamento do vídeo");
}

// POST /stories/publish - publicar imediatamente
app.post("/stories/publish", upload.single("media"), async (req, res) => {
  const { ig_id, media_url, media_type } = req.body;

  try {
    let finalUrl = media_url;

    // Se upload de arquivo local
    if (req.file) {
      finalUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    }

    if (!finalUrl) return res.status(400).json({ error: "Nenhuma mídia enviada" });

    const result = await publishStory(
      ig_id,
      finalUrl,
      media_type || (req.file?.mimetype.includes("video") ? "VIDEO" : "IMAGE")
    );

    // Salvar no histórico
    const db = readDB();
    db.history.unshift({
      id: Date.now().toString(),
      ig_id,
      media_url: finalUrl,
      media_type: media_type || "IMAGE",
      status: "published",
      published_at: new Date().toISOString(),
      media_id: result.media_id,
    });
    writeDB(db);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Falha ao publicar story", details: err.response?.data });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AGENDAMENTO
// ══════════════════════════════════════════════════════════════════════════════

// POST /stories/schedule - agendar story
app.post("/stories/schedule", upload.single("media"), (req, res) => {
  const { ig_id, media_url, media_type, scheduled_at, caption } = req.body;

  let finalUrl = media_url;
  if (req.file) {
    finalUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  }

  if (!finalUrl) return res.status(400).json({ error: "Nenhuma mídia enviada" });
  if (!scheduled_at) return res.status(400).json({ error: "Data de agendamento obrigatória" });

  const scheduledDate = new Date(scheduled_at);
  if (scheduledDate <= new Date()) {
    return res.status(400).json({ error: "Data deve ser no futuro" });
  }

  const db = readDB();
  const job = {
    id: Date.now().toString(),
    ig_id,
    media_url: finalUrl,
    media_type: media_type || "IMAGE",
    scheduled_at: scheduledDate.toISOString(),
    caption: caption || "",
    status: "pending",
    created_at: new Date().toISOString(),
  };

  db.scheduled.push(job);
  writeDB(db);

  res.json({ success: true, job });
});

// GET /stories/scheduled - listar agendados
app.get("/stories/scheduled", (req, res) => {
  const db = readDB();
  const { ig_id } = req.query;
  let scheduled = db.scheduled.filter((s) => s.status === "pending");
  if (ig_id) scheduled = scheduled.filter((s) => s.ig_id === ig_id);
  res.json({ scheduled: scheduled.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at)) });
});

// DELETE /stories/scheduled/:id - cancelar agendamento
app.delete("/stories/scheduled/:id", (req, res) => {
  const db = readDB();
  const idx = db.scheduled.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Agendamento não encontrado" });
  db.scheduled[idx].status = "cancelled";
  writeDB(db);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// HISTÓRICO & ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

app.get("/stories/history", (req, res) => {
  const db = readDB();
  const { ig_id, limit = 20 } = req.query;
  let history = db.history;
  if (ig_id) history = history.filter((h) => h.ig_id === ig_id);
  res.json({ history: history.slice(0, parseInt(limit)) });
});

// GET /stories/:media_id/insights - métricas de um story
app.get("/stories/:media_id/insights", async (req, res) => {
  const { ig_id } = req.query;
  const db = readDB();
  const account = db.accounts[ig_id];
  if (!account) return res.status(404).json({ error: "Conta não encontrada" });

  try {
    const insightsRes = await axios.get(
      `${CONFIG.GRAPH_API}/${req.params.media_id}/insights`,
      {
        params: {
          metric: "impressions,reach,replies,exits,taps_forward,taps_back",
          access_token: account.page_token,
        },
      }
    );
    res.json({ insights: insightsRes.data.data });
  } catch (err) {
    res.status(500).json({ error: "Falha ao buscar insights", details: err.response?.data });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CRON - Verificar agendamentos a cada minuto
// ══════════════════════════════════════════════════════════════════════════════

cron.schedule("* * * * *", async () => {
  const db = readDB();
  const now = new Date();
  const pending = db.scheduled.filter(
    (s) => s.status === "pending" && new Date(s.scheduled_at) <= now
  );

  for (const job of pending) {
    console.log(`⏰ Publicando story agendado: ${job.id} para @${job.ig_id}`);
    try {
      const result = await publishStory(job.ig_id, job.media_url, job.media_type);

      // Atualizar status
      const idx = db.scheduled.findIndex((s) => s.id === job.id);
      db.scheduled[idx].status = "published";
      db.scheduled[idx].published_at = new Date().toISOString();
      db.scheduled[idx].media_id = result.media_id;

      db.history.unshift({
        ...job,
        status: "published",
        published_at: new Date().toISOString(),
        media_id: result.media_id,
      });

      console.log(`✅ Story ${job.id} publicado com sucesso!`);
    } catch (err) {
      console.error(`❌ Erro ao publicar story ${job.id}:`, err.message);
      const idx = db.scheduled.findIndex((s) => s.id === job.id);
      db.scheduled[idx].status = "error";
      db.scheduled[idx].error = err.message;
    }
    writeDB(db);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════

app.listen(CONFIG.PORT, () => {
  console.log(`
🤖 Stories Bot rodando na porta ${CONFIG.PORT}
📸 Instagram Graph API v19.0
⏰ Agendador ativo (verificando a cada minuto)

Endpoints:
  GET  /auth/login              → URL de autenticação Meta
  GET  /auth/callback           → Callback OAuth
  GET  /accounts                → Listar contas conectadas
  POST /stories/publish         → Publicar story agora
  POST /stories/schedule        → Agendar story
  GET  /stories/scheduled       → Listar agendamentos
  DELETE /stories/scheduled/:id → Cancelar agendamento
  GET  /stories/history         → Histórico de publicações
  GET  /stories/:id/insights    → Métricas do story
  `);
});