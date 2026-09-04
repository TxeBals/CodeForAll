const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CAMBIO DE FONDO respecto a la versión anterior:
// antes se le pedía al modelo "genera 6 noticias realistas", lo que producía
// noticias inventadas desde memoria de entrenamiento (de ahí las noticias
// antiguas fechadas hoy). Ahora se usa la herramienta web_search de la API y
// TODA noticia se valida contra los resultados de búsqueda reales:
//   - la URL tiene que aparecer en los resultados de búsqueda de esta ejecución
//   - la fecha de publicación tiene que estar dentro de MAX_AGE_DAYS
// Lo que no pasa el filtro se descarta. Si no queda nada, no se publica nada.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.NEWS_MODEL || 'claude-sonnet-4-6';
const MAX_AGE_DAYS = parseInt(process.env.NEWS_MAX_AGE_DAYS || '7', 10);
const TARGET_NEWS = parseInt(process.env.NEWS_TARGET || '6', 10);
// STRICT_URL=1 exige URL exacta en los resultados; =0 se conforma con el dominio.
const STRICT_URL = process.env.NEWS_STRICT_URL !== '0';
// FORCE: regenera las noticias de hoy aunque ya existan. Borra las autogeneradas
// con fecha de hoy y las vuelve a crear, para que no se acumulen duplicados.
// Uso: NEWS_FORCE=1 node scripts/generate-news.js   o   ... --force
const FORCE = process.env.NEWS_FORCE === '1' ||
  process.env.NEWS_FORCE === 'true' ||
  process.argv.includes('--force');
FORCE = true;
const POSTS_FILE = path.join(__dirname, '..', 'data', 'posts.json');
const POSTS_DIR = path.join(__dirname, '..', 'posts');

// web_search_20250305 = versión básica, compatible con todos los modelos.
// Las versiones 20260209+ añaden filtrado dinámico (requieren Claude 4.6+).
const SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 12,
  user_location: {
    type: 'approximate',
    country: 'ES',
    timezone: 'Europe/Madrid'
  }
};

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Falta ANTHROPIC_API_KEY en env vars');
  process.exit(1);
}

if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });

const client = new Anthropic({ maxRetries: 4, timeout: 180000 });

// ── Llamada a la API ─────────────────────────────────────────────────────────
// Cambios: soporta tools y maneja stop_reason 'pause_turn' (la API puede pausar
// un turno largo de búsqueda; hay que reenviar el mensaje del asistente tal cual).
async function callAnthropic({ messages, label, maxTokens = 4000, tools }) {
  console.log('[API] ' + label + '...');
  let convo = messages.slice();
  const blocks = [];

  for (let turn = 0; turn < 8; turn++) {
    const stream = client.messages.stream(
      Object.assign(
        { model: MODEL, max_tokens: maxTokens, messages: convo },
        tools ? { tools: tools } : {}
      )
    );
    const msg = await stream.finalMessage();
    blocks.push.apply(blocks, msg.content);

    if (msg.stop_reason === 'pause_turn') {
      console.log('[API] pause_turn, continuando...');
      convo = convo.concat([{ role: 'assistant', content: msg.content }]);
      continue;
    }
    if (msg.stop_reason === 'max_tokens') {
      throw new Error('Respuesta truncada por max_tokens en "' + label + '"');
    }
    const searches = (msg.usage && msg.usage.server_tool_use &&
      msg.usage.server_tool_use.web_search_requests) || 0;
    if (searches) console.log('[API] busquedas realizadas: ' + searches);
    return blocks;
  }
  throw new Error('Demasiados pause_turn en "' + label + '"');
}

function textOf(blocks) {
  return blocks
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

// ── Cosecha de fuentes reales ────────────────────────────────────────────────
// Recorre los bloques web_search_tool_result y las citations para construir el
// mapa de URLs que la API ha visto de verdad, con su page_age.
function harvestSources(blocks) {
  const byUrl = new Map();

  const add = (url, title, pageAge) => {
    if (!url) return;
    const key = normalizeUrl(url);
    if (!key) return;
    const prev = byUrl.get(key);
    if (!prev) byUrl.set(key, { url, title: title || '', pageAge: pageAge || null });
    else if (!prev.pageAge && pageAge) prev.pageAge = pageAge;
  };

  for (const b of blocks) {
    if (b.type === 'web_search_tool_result') {
      if (b.content && b.content.type === 'web_search_tool_result_error') {
        console.warn('⚠️ Error de busqueda: ' + b.content.error_code);
        continue;
      }
      for (const r of b.content || []) {
        if (r.type === 'web_search_result') add(r.url, r.title, r.page_age);
      }
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) add(c.url, c.title, null);
    }
  }
  return byUrl;
}

function normalizeUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const p = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return host + p;
  } catch (_) {
    return null;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return null;
  }
}

// page_age llega como "April 30, 2025", ISO, o a veces "3 days ago".
function parseDateish(value) {
  if (!value) return null;
  const rel = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(String(value).trim());
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unitDays = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 };
    const d = new Date();
    d.setDate(d.getDate() - n * unitDays[rel[2].toLowerCase()]);
    return d;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function ageInDays(date) {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

// ── Validación: aquí es donde se corta el invento ────────────────────────────
function validateItem(item, sources, seen) {
  if (!item || !item.title || !item.description || !item.sourceUrl) {
    return { ok: false, reason: 'campos obligatorios ausentes' };
  }
  if (!/^https:\/\//i.test(item.sourceUrl)) {
    return { ok: false, reason: 'sourceUrl no es https' };
  }

  const key = normalizeUrl(item.sourceUrl);
  const host = hostOf(item.sourceUrl);
  let source = sources.get(key);

  if (!source && !STRICT_URL) {
    for (const [k, v] of sources) {
      if (k.split('/')[0] === host) { source = v; break; }
    }
  }
  if (!source) {
    return { ok: false, reason: 'la URL no aparece en los resultados de busqueda (posible invencion)' };
  }

  const declared = parseDateish(item.publishedDate);
  const fromPage = parseDateish(source.pageAge);
  const best = declared || fromPage;
  if (!best) {
    return { ok: false, reason: 'sin fecha de publicacion verificable' };
  }
  const age = ageInDays(best);
  if (age > MAX_AGE_DAYS) {
    return { ok: false, reason: 'antigua (' + age + ' dias, limite ' + MAX_AGE_DAYS + ')' };
  }
  if (age < -1) {
    return { ok: false, reason: 'fecha en el futuro (' + best.toISOString().split('T')[0] + ')' };
  }
  if (declared && fromPage && Math.abs(ageInDays(declared) - ageInDays(fromPage)) > 30) {
    return { ok: false, reason: 'fecha declarada incoherente con la de la fuente' };
  }

  if (seen.urls.has(key)) return { ok: false, reason: 'duplicada (URL ya publicada)' };
  const slug = slugify(item.title);
  if (seen.slugs.has(slug)) return { ok: false, reason: 'duplicada (titulo ya publicado)' };

  return { ok: true, publishedAt: best, slug: slug, urlKey: key };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log('Buscando noticias de IA para ' + today + ' (max ' + MAX_AGE_DAYS + ' dias de antiguedad)...');

  const postsData = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));

  // Suelo de IDs: se calcula ANTES de borrar nada, para no reutilizar ids de
  // posts eliminados (romperia enlaces y guids del RSS ya indexados).
  const idFloor = Math.max.apply(null, postsData.posts.map(p => p.id).concat([0]));

  const todayNews = postsData.posts.filter(p => p.autoGenerated && p.date === today);
  if (todayNews.length > 0) {
    if (!FORCE) {
      console.log('⏭️ Ya existen ' + todayNews.length + ' noticias de hoy. Saltando.');
      console.log('   (NEWS_FORCE=1 o --force para regenerarlas)');
      generateSitemap(postsData.posts);
      generateRSS(postsData.posts);
      return;
    }
    console.log('🔁 FORCE activo: elimino ' + todayNews.length + ' noticias autogeneradas de hoy y regenero.');
    postsData.posts = postsData.posts.filter(p => !(p.autoGenerated && p.date === today));
  } else if (FORCE) {
    console.log('🔁 FORCE activo (no habia noticias de hoy que reemplazar).');
  }

  // Historial para deduplicar contra lo ya publicado.
  const seen = { urls: new Set(), slugs: new Set() };
  for (const p of postsData.posts) {
    const k = p.sourceUrl && normalizeUrl(p.sourceUrl);
    if (k) seen.urls.add(k);
    if (p.slug) seen.slugs.add(p.slug);
  }

  const searchPrompt =
    'Hoy es ' + today + '. Busca en la web noticias TECNICAS de IA para developers ' +
    'publicadas en los ultimos ' + MAX_AGE_DAYS + ' dias.\n\n' +
    'Haz varias busquedas distintas para cubrir: modelos y APIs de LLM (lanzamientos, ' +
    'cambios de precio, deprecaciones), frameworks y herramientas de agentes, repos de ' +
    'GitHub que esten despuntando ahora, y arquitectura o buenas practicas.\n\n' +
    'REGLAS INNEGOCIABLES:\n' +
    '1. Solo puedes reportar lo que aparezca en los resultados de busqueda de ESTA ' +
    'conversacion. No uses tu conocimiento previo: esta desactualizado.\n' +
    '2. sourceUrl debe copiarse EXACTA de un resultado de busqueda. No la construyas ' +
    'ni la deduzcas.\n' +
    '3. publishedDate en formato YYYY-MM-DD, tomada del articulo o del resultado. Si no ' +
    'la puedes determinar, descarta la noticia.\n' +
    '4. Descarta cualquier cosa publicada hace mas de ' + MAX_AGE_DAYS + ' dias.\n' +
    '5. Es CORRECTO devolver menos de ' + TARGET_NEWS + ' noticias, o incluso un array ' +
    'vacio []. Es INACEPTABLE rellenar con noticias que no hayas encontrado hoy.\n\n' +
    'Objetivo: hasta ' + TARGET_NEWS + ' noticias. Devuelve SOLO un JSON array, sin texto ' +
    'alrededor ni markdown:\n' +
    '[{"title":"...","description":"...","sourceUrl":"https://...","sourceName":"...",' +
    '"publishedDate":"YYYY-MM-DD","category":"LLM|AGENTES|HERRAMIENTAS|GITHUB_REPO|' +
    'BUENAS_PRACTICAS|INVESTIGACION","tags":["..."],"keyPoints":["..."]}]';

  const blocks = await callAnthropic({
    messages: [{ role: 'user', content: searchPrompt }],
    label: 'Busqueda de noticias',
    maxTokens: 8000,
    tools: [SEARCH_TOOL]
  });

  const sources = harvestSources(blocks);
  console.log('Fuentes reales vistas en la busqueda: ' + sources.size);
  if (sources.size === 0) {
    console.error('❌ La busqueda no devolvio ningun resultado. Aborto sin publicar.');
    process.exit(1);
  }

  let candidates;
  try {
    candidates = extractJSONArray(textOf(blocks).replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Error parseando noticias:', e.message);
    process.exit(1);
  }
  console.log('Candidatas devueltas: ' + candidates.length);

  const accepted = [];
  for (const item of candidates) {
    const v = validateItem(item, sources, seen);
    if (!v.ok) {
      console.warn('⛔ Descartada [' + v.reason + ']: ' + (item && item.title));
      continue;
    }
    seen.urls.add(v.urlKey);
    seen.slugs.add(v.slug);
    accepted.push(Object.assign({}, item, { _slug: v.slug, _publishedAt: v.publishedAt }));
  }

  console.log('Aceptadas: ' + accepted.length + '/' + candidates.length);

  // Lo que pediste: si no hay noticia fresca y verificable, no se publica nada.
  if (accepted.length === 0) {
    console.log('ℹ️ Ninguna noticia supera los filtros de frescura/procedencia. No se publica hoy.');
    return;
  }

  const maxId = Math.max.apply(null, postsData.posts.map(p => p.id).concat([idFloor, 0]));

  for (let i = 0; i < accepted.length; i++) {
    const item = accepted[i];
    console.log('Articulo ' + (i + 1) + '/' + accepted.length + ': ' + item.title);

    let contentBlocks;
    try {
      // El articulo se ancla a la fuente concreta y se prohibe anadir datos.
      const artBlocks = await callAnthropic({
        messages: [{
          role: 'user',
          content:
            'Escribe un articulo breve (150 palabras) en espanol sobre esta noticia.\n\n' +
            'Titulo: ' + item.title + '\n' +
            'Resumen: ' + item.description + '\n' +
            'Puntos clave: ' + JSON.stringify(item.keyPoints || []) + '\n' +
            'Fuente: ' + item.sourceUrl + ' (' + item.sourceName + ')\n' +
            'Fecha: ' + item.publishedDate + '\n\n' +
            'No anadas versiones, cifras, fechas ni nombres de producto que no esten ' +
            'arriba. Si falta contexto, escribe menos.\n' +
            'Devuelve SOLO un JSON array de bloques:\n' +
            '[{"type":"t","text":"#1. Titulo"},{"type":"p","text":"..."}]'
        }],
        label: 'Articulo ' + (i + 1),
        maxTokens: 1000
      });
      contentBlocks = extractJSONArray(textOf(artBlocks).replace(/```json|```/g, '').trim());
    } catch (e) {
      console.warn('Fallback para articulo ' + (i + 1) + ': ' + e.message);
      contentBlocks = [
        { type: 't', text: '#1. ' + item.title },
        { type: 'p', text: item.description }
      ];
    }

    postsData.posts.unshift({
      id: maxId + i + 1,
      date: today,
      dateDisplay: formatDateSpanish(today),
      publishedDate: item._publishedAt.toISOString().split('T')[0],
      title: item.title,
      slug: item._slug,
      description: item.description,
      image: getCategoryImage(item.category),
      url: 'post.html?slug=' + item._slug,
      folder: item.category,
      source: 'auto',
      autoGenerated: true,
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName,
      category: item.category,
      content: contentBlocks,
      tags: item.tags || []
    });

    if (i < accepted.length - 1) await sleep(8000);
  }

  fs.writeFileSync(POSTS_FILE, JSON.stringify(postsData, null, 2), 'utf8');
  console.log('posts.json actualizado con ' + accepted.length + ' noticias');

  generateSitemap(postsData.posts);
  generateRSS(postsData.posts);
  console.log('✅ Completado');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractJSONArray(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}

  const startIdx = text.indexOf('[');
  if (startIdx !== -1) {
    let depth = 0, inString = false, escape = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '[') depth++;
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.substring(startIdx, i + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch (_) {}
          break;
        }
      }
    }
  }

  const objects = [];
  const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let m;
  while ((m = objRegex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj.title && obj.description) objects.push(obj);
    } catch (_) {}
  }
  if (objects.length > 0) {
    console.log('[Parse] Recuperados ' + objects.length + ' items');
    return objects;
  }
  if (/^\s*\[\s*\]\s*$/.test(text)) return [];

  throw new Error('No se pudo extraer JSON array valido del response');
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function formatDateSpanish(dateStr) {
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const [y, m, d] = dateStr.split('-');
  return parseInt(d) + ' de ' + months[parseInt(m) - 1] + ' de ' + y;
}

function getCategoryImage(category) {
  const images = {
    LLM: 'images/posts/llm-default.svg',
    AGENTES: 'images/posts/agents-default.svg',
    HERRAMIENTAS: 'images/posts/tools-default.svg',
    GITHUB_REPO: 'images/posts/github-default.svg',
    BUENAS_PRACTICAS: 'images/posts/best-practices-default.svg',
    INVESTIGACION: 'images/posts/research-default.svg',
  };
  return images[category] || 'images/posts/ai-news-default.svg';
}

function generateSitemap(posts) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += '  <url><loc>https://txemagonzalez.com/</loc><priority>1.0</priority></url>\n';
  xml += '  <url><loc>https://txemagonzalez.com/about.html</loc><priority>0.8</priority></url>\n';
  posts.forEach(p => {
    xml += '  <url><loc>https://txemagonzalez.com/' + p.url + '</loc><lastmod>' + p.date + '</lastmod></url>\n';
  });
  xml += '</urlset>';
  fs.writeFileSync(path.join(__dirname, '..', 'sitemap.xml'), xml, 'utf8');
}

function generateRSS(posts) {
  const recent = posts.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);
  let rss = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n';
  rss += '  <title>Code 4 All - Txema González Balseiro</title>\n';
  rss += '  <link>https://txemagonzalez.com/</link>\n';
  rss += '  <description>Blog de desarrollo, IA y Azure</description>\n';
  rss += '  <language>es</language>\n';
  rss += '  <atom:link href="https://txemagonzalez.com/feed.xml" rel="self" type="application/rss+xml"/>\n';

  recent.forEach(p => {
    const link = 'https://txemagonzalez.com/' + p.url;
    rss += '  <item><title>' + escapeXml(p.title) + '</title><link>' + escapeXml(link) + '</link>';
    rss += '<description>' + escapeXml(p.description) + '</description><pubDate>' + new Date(p.date).toUTCString() + '</pubDate>';
    rss += '<guid>' + escapeXml(link) + '</guid>';
    if (p.folder) rss += '<category>' + escapeXml(p.folder) + '</category>';
    rss += '</item>\n';
  });

  rss += '</channel>\n</rss>';
  fs.writeFileSync(path.join(__dirname, '..', 'feed.xml'), rss, 'utf8');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
