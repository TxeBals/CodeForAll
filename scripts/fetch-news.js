const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic();
const POSTS_FILE = path.join(__dirname, '..', 'data', 'posts.json');
const POSTS_DIR = path.join(__dirname, '..', 'posts');

// Ensure posts/ directory exists
if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });

// ── Rate-limit aware API call with retry ──

async function callAPI(params, label) {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log('[API] ' + label + ' (intento ' + attempt + ')...');
      const response = await client.messages.create(params);
      return response;
    } catch (e) {
      if (e.status === 429 || (e.error && e.error.error && e.error.error.type === 'rate_limit_error')) {
        // Parse retry-after from headers or error, default to escalating wait
        let waitSecs = 60 * attempt; // 60s, 120s, 180s...
        if (e.headers && e.headers['retry-after']) {
          waitSecs = Math.max(parseInt(e.headers['retry-after']) + 5, waitSecs);
        }
        console.log('[Rate limit] Esperando ' + waitSecs + 's antes de reintentar...');
        await sleep(waitSecs * 1000);
      } else if (e.status === 529 || e.status === 503) {
        // Overloaded
        const waitSecs = 30 * attempt;
        console.log('[Overloaded] Esperando ' + waitSecs + 's...');
        await sleep(waitSecs * 1000);
      } else {
        throw e; // Non-retryable error
      }
    }
  }
  throw new Error('Agotados todos los reintentos para: ' + label);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log('Buscando noticias de IA para ' + today + '...');

  // ── STEP 1: Search for news (single call with web_search) ──
  const searchResponse = await callAPI({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: 'Busca 4 noticias de IA de hoy. Para cada una devuelve JSON:\n' +
        '[{"title":"titulo en espanol","description":"2 frases","sourceUrl":"url","sourceName":"fuente",' +
        '"category":"LLM|AGENTES|HERRAMIENTAS|GITHUB_REPO|BUENAS_PRACTICAS|INVESTIGACION",' +
        '"tags":["t1","t2","t3"],"keyPoints":["p1","p2","p3"]}]\n' +
        'Temas: LLMs, agentes IA, herramientas dev, repos GitHub ML/AI.\n' +
        'SOLO JSON array, sin backticks.'
    }]
  }, 'Busqueda de noticias');

  // 2. Extract text from response
  const textBlocks = searchResponse.content.filter(b => b.type === 'text');
  const rawText = textBlocks.map(b => b.text).join('\n');
  const cleanText = rawText.replace(/```json|```/g, '').trim();

  let newsItems;
  try {
    const match = cleanText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array found');
    newsItems = JSON.parse(match[0]);
  } catch (e) {
    console.error('Error parseando noticias:', e.message);
    console.log('Raw response:', cleanText.substring(0, 500));
    process.exit(1);
  }

  console.log('Encontradas ' + newsItems.length + ' noticias');

  // 3. Read existing posts.json
  const postsData = JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
  const maxId = Math.max(...postsData.posts.map(p => p.id), 0);

  // ── STEP 2: Generate articles one by one with long pauses ──
  // Wait 65s after search to let rate limit window reset
  console.log('[Pausa] Esperando 65s para respetar rate limits...');
  await sleep(65000);

  for (let i = 0; i < newsItems.length; i++) {
    const item = newsItems[i];
    const newId = maxId + i + 1;
    const slug = slugify(item.title);

    console.log('Generando articulo ' + (i + 1) + '/' + newsItems.length + ': ' + item.title);

    let contentBlocks;
    try {
      // Use haiku for articles - much lower token usage, faster, cheaper
      const articleResponse = await callAPI({
        model: 'claude-haiku-4-20250414',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: 'Escribe un articulo tecnico en espanol (300-500 palabras) sobre:\n' +
            'Titulo: ' + item.title + '\n' +
            'Fuente: ' + item.sourceName + '\n' +
            'Descripcion: ' + item.description + '\n' +
            'Puntos clave: ' + (item.keyPoints || []).join('; ') + '\n\n' +
            'Secciones: 1)Contexto 2)Detalles tecnicos 3)Impacto practico 4)Recursos\n' +
            'Formato: JSON array de bloques:\n' +
            '[{"type":"t","text":"#1. Seccion"},{"type":"p","text":"Parrafo..."}]\n' +
            'SOLO JSON array.'
        }]
      }, 'Articulo ' + (i + 1));

      const articleText = articleResponse.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const artMatch = articleText.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
      contentBlocks = JSON.parse(artMatch[0]);
    } catch (e) {
      console.warn('Error en articulo ' + (i + 1) + ' (' + e.message + '), usando fallback');
      contentBlocks = [
        { type: 't', text: '#1. ' + item.title },
        { type: 'p', text: item.description },
        { type: 'p', text: 'Puntos clave: ' + (item.keyPoints || []).join('. ') },
        { type: 'p', text: 'Fuente original: <a href="' + item.sourceUrl + '" target="_blank">' + item.sourceName + '</a>' }
      ];
    }

    // 5. Add to posts.json
    const newPost = {
      id: newId,
      date: today,
      dateDisplay: formatDateSpanish(today),
      title: item.title,
      slug: slug,
      description: item.description,
      image: getCategoryImage(item.category),
      url: 'post.html?slug=' + slug,
      folder: item.category,
      source: 'auto',
      autoGenerated: true,
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName,
      category: item.category,
      content: contentBlocks,
      tags: item.tags || []
    };

    postsData.posts.unshift(newPost);

    // Wait 65s between article generations to respect per-minute limits
    if (i < newsItems.length - 1) {
      console.log('[Pausa] Esperando 65s entre articulos...');
      await sleep(65000);
    }
  }

  // 6. Save updated posts.json
  fs.writeFileSync(POSTS_FILE, JSON.stringify(postsData, null, 2), 'utf8');
  console.log('posts.json actualizado con ' + newsItems.length + ' noticias nuevas');

  // 7. Generate sitemap.xml
  generateSitemap(postsData.posts);

  // 8. Generate feed.xml (RSS)
  generateRSS(postsData.posts);

  console.log('Proceso completado');
}

// ── Helpers ──

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
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += '  <url><loc>https://txemagonzalez.com/</loc><priority>1.0</priority></url>\n';
  xml += '  <url><loc>https://txemagonzalez.com/about.html</loc><priority>0.8</priority></url>\n';
  posts.forEach(p => {
    const loc = 'https://txemagonzalez.com/' + p.url;
    xml += '  <url><loc>' + loc + '</loc><lastmod>' + p.date + '</lastmod></url>\n';
  });
  xml += '</urlset>';
  fs.writeFileSync(path.join(__dirname, '..', 'sitemap.xml'), xml, 'utf8');
  console.log('sitemap.xml generado');
}

function generateRSS(posts) {
  const recentPosts = posts
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);

  let rss = '<?xml version="1.0" encoding="UTF-8"?>\n';
  rss += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n';
  rss += '<channel>\n';
  rss += '  <title>Code 4 All - Txema Gonz\u00e1lez Balseiro</title>\n';
  rss += '  <link>https://txemagonzalez.com/</link>\n';
  rss += '  <description>Blog de desarrollo, IA y Azure</description>\n';
  rss += '  <language>es</language>\n';
  rss += '  <atom:link href="https://txemagonzalez.com/feed.xml" rel="self" type="application/rss+xml"/>\n';

  recentPosts.forEach(p => {
    const link = 'https://txemagonzalez.com/' + p.url;
    rss += '  <item>\n';
    rss += '    <title>' + escapeXml(p.title) + '</title>\n';
    rss += '    <link>' + escapeXml(link) + '</link>\n';
    rss += '    <description>' + escapeXml(p.description) + '</description>\n';
    rss += '    <pubDate>' + new Date(p.date).toUTCString() + '</pubDate>\n';
    rss += '    <guid>' + escapeXml(link) + '</guid>\n';
    if (p.folder) {
      rss += '    <category>' + escapeXml(p.folder) + '</category>\n';
    }
    rss += '  </item>\n';
  });

  rss += '</channel>\n';
  rss += '</rss>';
  fs.writeFileSync(path.join(__dirname, '..', 'feed.xml'), rss, 'utf8');
  console.log('feed.xml generado');
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
