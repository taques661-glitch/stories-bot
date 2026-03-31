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

// Fallback para sua conta pessoal (retrocompatibilidade)
const IG_TOKEN_DEFAULT = process.env.IG_TOKEN;
const IG_ID_DEFAULT = process.env.IG_ID;
const PORT = process.env.PORT || 3001;

// SUPABASE
const SUPABASE_URL = process.env.SUPABASE_URL || "https://uhayvtncounslqlchtpz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoYXl2dG5jb3Vuc2xxbGNodHB6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzE3OTY1OSwiZXhwIjoyMDg4NzU1NjU5fQ.w89OUR7prkaLF4G2SJ2r4ZGqfvHzq0XNv7qzZkCY8mg";

const sbHeaders = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Prefer": "return=representation"
};

// Busca credenciais Instagram do tenant
async function getIgCreds(tenantId) {
  if (!tenantId || tenantId === "kevin_admin") {
    return { token: IG_TOKEN_DEFAULT, igId: IG_ID_DEFAULT };
  }
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/clientes?tenant_id=eq.${tenantId}&select=ig_token,ig_id,stories_ativo`,
      { headers: sbHeaders }
    );
    const c = r.data?.[0];
    if (!c || !c.stories_ativo) return null; // módulo não ativo
    if (!c.ig_token || !c.ig_id) return null; // não conectado
    return { token: c.ig_token, igId: c.ig_id };
  } catch (e) {
    console.error("getIgCreds error:", e.message);
    return null;
  }
}

async function sbGet(query = "") {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/stories_tfx?${query}&order=date.asc,time.asc`, { headers: sbHeaders });
  return r.data;
}
async function sbUpsert(story) {
  const row = {
    id: story.id,
    ig_id: story.ig_id || IG_ID_DEFAULT,
    tenant_id: story.tenant_id || "kevin_admin",
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

function cleanCloudinaryUrl(url) {
  if (!url || !url.includes('cloudinary.com')) return url;
  return url.replace(/\/upload\/[^/]+\/v/, '/upload/v');
}

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

// ── OAUTH INSTAGRAM ─────────────────────────────────────────
const META_APP_ID = process.env.META_APP_ID || "940737518533672";
const META_APP_SECRET = process.env.META_APP_SECRET || "SUA_SECRET_AQUI";
const REDIRECT_URI = process.env.REDIRECT_URI || "https://stories-tfx.onrender.com/oauth/callback";

// Redireciona para o login do Instagram
app.get("/oauth/instagram", (req, res) => {
  const tenantId = req.query.tenant_id || "kevin_admin";
  const state = Buffer.from(tenantId).toString("base64");
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement&state=${state}&response_type=code`;
  res.redirect(url);
});

// Callback OAuth — salva token no Supabase
app.get("/oauth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Sem código de autorização");

  let tenantId = "kevin_admin";
  try { tenantId = Buffer.from(state, "base64").toString("utf8"); } catch(e) {}

  try {
    // Troca code por token de curta duração
    const tokenRes = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token`, {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: REDIRECT_URI, code }
    });
    const shortToken = tokenRes.data.access_token;

    // Troca por token longo (~60 dias)
    const longTokenRes = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token`, {
      params: { grant_type: "fb_exchange_token", client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: shortToken }
    });
    const longToken = longTokenRes.data.access_token;

    // Busca páginas do usuário
    const pagesRes = await axios.get(`https://graph.facebook.com/v19.0/me/accounts`, {
      params: { access_token: longToken }
    });
    const page = pagesRes.data.data?.[0];
    if (!page) return res.status(400).send("Nenhuma página encontrada. Você precisa ter uma Página do Facebook conectada ao Instagram.");

    const pageToken = page.access_token;
    const pageId = page.id;

    // Busca conta Instagram da página
    const igRes = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
      params: { fields: "instagram_business_account", access_token: pageToken }
    });
    const igId = igRes.data?.instagram_business_account?.id;
    if (!igId) return res.status(400).send("Nenhuma conta Instagram Business encontrada nesta página.");

    // Busca token longo da página
    const pageTokenLongRes = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token`, {
      params: { grant_type: "fb_exchange_token", client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: pageToken }
    });
    const igToken = pageTokenLongRes.data.access_token || pageToken;

    // Salva no Supabase
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/clientes?tenant_id=eq.${tenantId}`,
      { ig_token: igToken, ig_id: igId },
      { headers: sbHeaders }
    );

    console.log(`[OAuth] tenant ${tenantId} conectou Instagram: ig_id=${igId}`);
    res.send(`<h2 style="font-family:monospace;color:green;padding:40px">✅ Instagram conectado com sucesso!<br><small style="color:#888">Pode fechar esta janela.</small></h2>`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error("[OAuth] Erro:", msg);
    res.status(500).send(`<h2 style="font-family:monospace;color:red;padding:40px">❌ Erro ao conectar: ${msg}</h2>`);
  }
});

// Status de conexão do Instagram por tenant
app.get("/ig-status", async (req, res) => {
  const tenantId = req.query.tenant_id || "kevin_admin";
  const creds = await getIgCreds(tenantId);
  if (!creds) return res.json({ connected: false });
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${creds.igId}?fields=name,username&access_token=${creds.token}`);
    res.json({ connected: true, username: r.data.username, name: r.data.name });
  } catch(e) {
    res.json({ connected: false, error: e.response?.data?.error?.message || e.message });
  }
});

// ── ROTAS EXISTENTES (agora multi-tenant) ───────────────────

app.get("/api", (req, res) => res.json({ status: "ok" }));
app.get("/health", (req, res) => res.sendStatus(200));
app.get("/config", (req, res) => res.json({
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || "dbwdldowa",
  uploadPreset: "stories_tfx_unsigned"
}));

app.get("/accounts", async (req, res) => {
  const tenantId = req.query.tenant_id || "kevin_admin";
  const creds = await getIgCreds(tenantId);
  if (!creds) return res.json({ accounts: [], connected: false });
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${creds.igId}?fields=name,username,followers_count&access_token=${creds.token}`);
    res.json({ accounts: [{ ig_id: creds.igId, username: r.data.username, name: r.data.name, followers: r.data.followers_count || 0 }], connected: true });
  } catch(e) {
    res.json({ accounts: [{ ig_id: creds.igId, username: "—", followers: 0 }], connected: true });
  }
});

// GET stories — filtra por tenant_id
app.get("/schedule", async (req, res) => {
  const tenantId = req.query.tenant_id || "kevin_admin";
  try {
    const rows = await sbGet(`tenant_id=eq.${tenantId}&select=*`);
    const stories = rows.map(r => ({
      id: r.id, ig_id: r.ig_id, tenant_id: r.tenant_id,
      url: r.url, date: r.date, time: r.time,
      caption: r.caption, status: r.status,
      mediaType: r.media_type, repeat: r.repeat_rule, link: r.link || ""
    }));
    res.json({ stories });
  } catch (e) {
    console.error("sbGet error:", e.message);
    res.json({ stories: [] });
  }
});

// POST - save story
app.post("/schedule", async (req, res) => {
  try {
    await sbUpsert(req.body);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH - update story
app.patch("/schedule/:id", async (req, res) => {
  try {
    const fields = {};
    if (req.body.status) fields.status = req.body.status;
    if (req.body.date) fields.date = req.body.date;
    if (req.body.time) fields.time = req.body.time;
    if (req.body.caption !== undefined) fields.caption = req.body.caption;
    if (req.body.url) fields.url = req.body.url;
    if (req.body.link !== undefined) fields.link = req.body.link;
    if (req.body.mediaType) fields.media_type = req.body.mediaType;
    await sbUpdate(req.params.id, fields);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE story
app.delete("/schedule/:id", async (req, res) => {
  try {
    await sbDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPLOAD to Cloudinary
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
    res.json({ url: cleanCloudinaryUrl(result.secure_url), mediaType: isVideo ? "VIDEO" : "IMAGE" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUBLISH story to Instagram
app.post("/stories/publish", upload.single("file"), async (req, res) => {
  try {
    const tenantId = req.body?.tenant_id || "kevin_admin";
    const creds = await getIgCreds(tenantId);
    if (!creds) return res.status(403).json({ error: "Instagram não conectado ou módulo Stories não ativo." });

    const { token, igId } = creds;
    let mediaUrl = req.body?.media_url;
    let mediaType = req.body?.media_type || "IMAGE";

    if (req.file) {
      const isVideo = req.file.mimetype.startsWith("video");
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: isVideo ? "video" : "image", folder: "stories_tfx", ...(isVideo ? { format: "mp4", eager: [{ fetch_format: "mp4", quality: "auto:good", bit_rate: "2m", width: 1080, height: 1920, crop: "limit" }], eager_async: true } : {}) },
          (err, r) => err ? reject(err) : resolve(r)
        );
        stream.end(req.file.buffer);
      });
      mediaUrl = cleanCloudinaryUrl(result.secure_url);
      mediaType = isVideo ? "VIDEO" : "IMAGE";
    }

    if (!mediaUrl) return res.status(400).json({ error: "No media URL" });
    mediaUrl = cleanCloudinaryUrl(mediaUrl);

    const isVideo = mediaType === "VIDEO";
    const containerRes = await axios.post(
      `https://graph.facebook.com/v19.0/${igId}/media`,
      { [isVideo ? "video_url" : "image_url"]: mediaUrl, media_type: "STORIES", access_token: token }
    );
    const containerId = containerRes.data.id;

    if (isVideo) {
      res.json({ success: true, processing: true });
      try {
        await waitForVideo(containerId, token);
        await axios.post(`https://graph.facebook.com/v19.0/${igId}/media_publish`, { creation_id: containerId, access_token: token });
      } catch (bgErr) {
        console.error(`Erro ao publicar vídeo:`, bgErr.response?.data || bgErr.message);
      }
    } else {
      await sleep(3000);
      await axios.post(`https://graph.facebook.com/v19.0/${igId}/media_publish`, { creation_id: containerId, access_token: token });
      res.json({ success: true });
    }
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: errMsg });
  }
});

// PUBLISH-DUE — chamado pelo cron a cada minuto
app.get("/publish-due", async (req, res) => {
  res.sendStatus(200);
  try {
    // Usa horário de Manaus (UTC-4)
    const now = new Date();
    const manaus = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    const dateStr = manaus.toISOString().split("T")[0];
    const times = [];
    for (let i = 0; i <= 3; i++) {
      const t = new Date(manaus - i * 60000);
      times.push(t.toISOString().substring(11, 16));
    }
    const allRows = [];
    for (const t of times) {
      const r = await sbGet(`status=eq.scheduled&date=eq.${dateStr}&time=eq.${t}`);
      allRows.push(...r);
    }
    const seen = new Set();
    const rows = allRows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
    console.log(`[publish-due] ${rows.length} stories para publicar`);

    for (const row of rows) {
      if (!row.url || row.url.includes("[arquivo")) continue;
      const tenantId = row.tenant_id || "kevin_admin";
      const creds = await getIgCreds(tenantId);
      if (!creds) {
        console.warn(`[publish-due] tenant ${tenantId} sem credenciais — pulando story ${row.id}`);
        await sbUpdate(row.id, { status: "error" });
        continue;
      }
      const { token, igId } = creds;
      await sbUpdate(row.id, { status: "publishing" });
      try {
        let mediaUrl = cleanCloudinaryUrl(row.url);
        const isVideo = (row.mediaType || row.media_type) === "VIDEO";
        if (isVideo && mediaUrl.includes('cloudinary.com') && !mediaUrl.endsWith('.mp4')) {
          mediaUrl = mediaUrl.replace(/\.[^.]+$/, '.mp4');
        }
        const containerRes = await axios.post(
          `https://graph.facebook.com/v19.0/${igId}/media`,
          { [isVideo ? "video_url" : "image_url"]: mediaUrl, media_type: "STORIES", access_token: token }
        );
        const containerId = containerRes.data.id;
        if (isVideo) {
          await waitForVideo(containerId, token);
        } else {
          await sleep(3000);
        }
        await axios.post(`https://graph.facebook.com/v19.0/${igId}/media_publish`, { creation_id: containerId, access_token: token });
        await sbUpdate(row.id, { status: "published" });
        console.log(`[publish-due] Story ${row.id} (tenant: ${tenantId}) publicado!`);
      } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        console.error(`[publish-due] Falha story ${row.id}:`, errMsg);
        await sbUpdate(row.id, { status: "error" });
      }
    }
  } catch (e) {
    console.error("[publish-due] Erro:", e.message);
  }
});

// Renovação automática de tokens (roda 1x por dia)
setInterval(async () => {
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/clientes?stories_ativo=eq.true&ig_token=not.is.null&select=tenant_id,ig_token`,
      { headers: sbHeaders }
    );
    for (const c of r.data || []) {
      try {
        const renewRes = await axios.get(`https://graph.facebook.com/v19.0/oauth/access_token`, {
          params: { grant_type: "ig_refresh_token", access_token: c.ig_token }
        });
        if (renewRes.data.access_token) {
          await axios.patch(
            `${SUPABASE_URL}/rest/v1/clientes?tenant_id=eq.${c.tenant_id}`,
            { ig_token: renewRes.data.access_token },
            { headers: sbHeaders }
          );
          console.log(`[Renovação] Token renovado para tenant ${c.tenant_id}`);
        }
      } catch(e) {
        console.warn(`[Renovação] Falha para tenant ${c.tenant_id}:`, e.message);
      }
    }
  } catch(e) {
    console.error("[Renovação] Erro:", e.message);
  }
}, 24 * 60 * 60 * 1000);

// Retry stories com erro
setInterval(async () => {
  try {
    const rows = await sbGet("status=eq.error");
    const now = Date.now();
    for (const row of rows) {
      if (!row.url || row.url.includes("[arquivo")) continue;
      const scheduledTime = new Date(row.date + 'T' + row.time + ':00').getTime();
      if (now - scheduledTime > 2 * 60 * 60 * 1000) continue;
      await sbUpdate(row.id, { status: "scheduled" });
    }
  } catch(e) { console.error("Retry error:", e.message); }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Stories TFX Multi-tenant rodando na porta ${PORT}`));
