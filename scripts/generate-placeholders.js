/**
 * generate-placeholders.js
 * Creates simple SVG placeholder images for post categories.
 * Run once: node scripts/generate-placeholders.js
 */

const fs = require('fs');
const path = require('path');

const imagesDir = path.join(__dirname, '..', 'images', 'posts');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

const categories = [
  { name: 'ai-news-default', label: 'AI News', color1: '#667eea', color2: '#764ba2', icon: 'AI' },
  { name: 'llm-default', label: 'LLM', color1: '#0d47a1', color2: '#1565c0', icon: 'LLM' },
  { name: 'agents-default', label: 'Agents', color1: '#880e4f', color2: '#c62828', icon: 'AGT' },
  { name: 'tools-default', label: 'Tools', color1: '#006064', color2: '#00838f', icon: 'DEV' },
  { name: 'github-default', label: 'GitHub', color1: '#1a1a2e', color2: '#333', icon: 'GH' },
  { name: 'best-practices-default', label: 'Best Practices', color1: '#33691e', color2: '#558b2f', icon: 'BP' },
  { name: 'research-default', label: 'Research', color1: '#4527a0', color2: '#5e35b1', icon: 'R&D' },
];

categories.forEach(cat => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${cat.color1}"/>
      <stop offset="100%" style="stop-color:${cat.color2}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="450" fill="url(#bg)"/>
  <text x="400" y="200" text-anchor="middle" fill="rgba(255,255,255,0.15)" font-size="120" font-family="Arial, sans-serif" font-weight="bold">${cat.icon}</text>
  <text x="400" y="280" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="32" font-family="Arial, sans-serif" font-weight="600">${cat.label}</text>
  <text x="400" y="320" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="16" font-family="Arial, sans-serif">Code 4 All</text>
</svg>`;

  // Save as SVG (browsers handle SVGs well, and it's much smaller than JPG)
  const svgPath = path.join(imagesDir, cat.name + '.svg');
  fs.writeFileSync(svgPath, svg, 'utf8');
  console.log('Created: ' + svgPath);
});

console.log('All placeholder images created.');
