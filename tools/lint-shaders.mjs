#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const shaderMarker = /\/\*\s*glsl\s*\*\/\s*`/g;
const failures = [];
let shaderCount = 0;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (extname(entry.name) === '.ts') out.push(path);
  }
  return out;
}

function extractShaderTemplates(source, file) {
  const templates = [];
  shaderMarker.lastIndex = 0;
  let match;

  while ((match = shaderMarker.exec(source))) {
    const start = shaderMarker.lastIndex;
    let end = start;
    let escaped = false;

    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '`') break;
    }

    if (end >= source.length) {
      failures.push(`${file}: unterminated /* glsl */ template literal`);
      break;
    }

    templates.push(source.slice(start, end));
    shaderMarker.lastIndex = end + 1;
  }

  return templates;
}

function lintShader(shader, file, index) {
  const label = `${file} shader #${index + 1}`;

  // THREE.GLSL3 injects the version directive itself. Supplying one in the
  // source creates a duplicate directive at runtime and fails compilation.
  if (/^\s*#version\b/m.test(shader)) {
    failures.push(`${label}: do not include #version; THREE.GLSL3 injects it`);
  }

  // STATIC's render graph is GLSL ES 3.00. Catch the two most common legacy
  // WebGL1 spellings before they reach a browser/GPU-specific compile path.
  if (/\bgl_FragColor\b/.test(shader)) {
    failures.push(`${label}: gl_FragColor is invalid in the GLSL3 pipeline; use fragColor`);
  }
  if (/\btexture2D\s*\(/.test(shader)) {
    failures.push(`${label}: texture2D() is legacy GLSL; use texture()`);
  }

  // Cheap structural check. It deliberately ignores parentheses because GLSL
  // comments often contain prose punctuation; braces are code-significant and
  // should always balance inside an individual shader template.
  let depth = 0;
  for (const ch of shader) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) failures.push(`${label}: unbalanced braces (${depth})`);
}

for (const path of await walk(SRC)) {
  const file = relative(SRC, path).replaceAll('\\', '/');
  const source = await readFile(path, 'utf8');

  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(source)) {
    failures.push(`${file}: unresolved merge-conflict marker`);
  }

  const shaders = extractShaderTemplates(source, file);
  shaderCount += shaders.length;
  shaders.forEach((shader, index) => lintShader(shader, file, index));
}

if (shaderCount === 0) {
  failures.push('No /* glsl */ template literals found under src; shader lint would be a no-op');
}

if (failures.length) {
  console.error('Shader lint failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Shader lint passed (${shaderCount} GLSL template${shaderCount === 1 ? '' : 's'}).`);
