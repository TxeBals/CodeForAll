const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic();
const POSTS_FILE = path.join(__dirname, '..', 'data', 'posts.json');
const POSTS_DIR = path.join(__dirname, '..', 'posts');

// Ensure posts/ directory exists
if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });

async function main() {
  const today = new Date().toISOString().split('T')[0];
  console.log('Buscando noticias de IA para ' + today + '...');

  // 1. Ask Claude to search for real news of the day
  const searchResponse = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: 'Busca las noticias m\u00e1s importantes de HOY sobre Inteligencia Artificial, enfocadas en:\n' +
        '- Nuevos modelos de lenguaje (LLMs) y sus lanzamientos\n' +
        '- Frameworks y herramientas para desarrollo con IA (LangChain, CrewAI, LangGraph, etc.)\n' +
        '- Mejores pr\u00e1cticas de desarrollo de agentes de IA\n' +
        '- Repositorios de GitHub relevantes y trending en ML/AI\n' +
        '- Novedades relevantes para desarrolladores que trabajan con LLMs\n\n' +
        'Necesito exactamente 4 noticias reales y recientes (de hoy o ayer m\u00e1ximo).\n\n' +
        'Para CADA noticia devuelve un JSON con:\n' +
        '- title: t\u00edtulo en espa\u00f1ol (conciso, informativo)\n' +
        '- description: resumen de 2-3 frases en espa\u00f1ol\n' +
        '- sourceUrl: URL real del art\u00edculo o repo original\n' +
        '- sourceName: nombre de la fuente (TechCrunch, GitHub, ArXiv, etc.)\n' +
        '- category: UNA de: LLM, AGENTES, HERRAMIENTAS, GITHUB_REPO, BUENAS_PRACTICAS, INVESTIGACION\n' +
        '- tags: array de 3-5 tags relevantes en espa\u00f1ol o ingl\u00e9s t\u00e9cnico\n' +
        '- keyPoints: array de 3-5 puntos clave del art\u00edculo\n\n' +
        'Devuelve SOLO un JSON array v\u00e1lido, sin backticks ni texto adicional.'
    }]
  });

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

  // 4. For each news item, generate full article
  for (let i = 0; i < newsItems.length; i++) {
    const item = newsItems[i];
    const newId = maxId + i + 1;
    const slug = slugify(item.title);

    console.log('Generando art\u00edculo ' + (i + 1) + '/' + newsItems.length + ': ' + item.title);

    // Generate full article
    const articleResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Busca m\u00e1s detalles sobre: "' + item.title + '" (fuente: ' + item.sourceName + ', ' + item.sourceUrl + ').\n\n' +
          'Escribe un art\u00edculo t\u00e9cnico en espa\u00f1ol (400-600 palabras) para un blog de desarrolladores.\n' +
          'El p\u00fablico son developers que trabajan con LLMs y agentes de IA.\n\n' +
          'Estructura el art\u00edculo as\u00ed:\n' +
          '1. Contexto: qu\u00e9 ha pasado y por qu\u00e9 es importante para developers\n' +
          '2. Detalles t\u00e9cnicos: qu\u00e9 tecnolog\u00edas implica, c\u00f3mo funciona\n' +
          '3. Impacto pr\u00e1ctico: c\u00f3mo afecta al trabajo diario de un developer\n' +
          '4. Para saber m\u00e1s: menciona recursos, repos o docs relevantes\n\n' +
          'Devuelve el art\u00edculo como un JSON array de bloques de contenido:\n' +
          '[{"type": "t", "text": "#1. T\u00edtulo de secci\u00f3n"}, {"type": "p", "text": "P\u00e1rrafo de texto..."}]\n\n' +
          'SOLO el JSON array, sin backticks ni texto extra.'
      }]
    });

    const articleText = articleResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    let contentBlocks;
    try {
      const artMatch = articleText.replace(/```json|```/g, '').trim().match(/\[[\s\S]*\]/);
      contentBlocks = JSON.parse(artMatch[0]);
    } catch (e) {
      console.warn('Error parseando art\u00edculo ' + (i + 1) + ', usando descripci\u00f3n como fallback');
      contentBlocks = [
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

    // Rate limit pause
    if (i < newsItems.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
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
    const loc = p.url.startsWith('post.html')
      ? 'https://txemagonzalez.com/' + p.url
      : 'https://txemagonzalez.com/' + p.url;
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
