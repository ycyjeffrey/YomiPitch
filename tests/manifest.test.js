import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('Manifest V3 configuration is valid, least-privilege, and all referenced files exist', () => {
  const manifestPath = path.join(ROOT, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist at project root');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '2.1.0');
  assert.ok(manifest.name && manifest.version && manifest.description);

  // Verify least-privilege permissions including MV3 offscreen document
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ['activeTab', 'contextMenus', 'offscreen', 'scripting', 'storage']
  );

  // Verify WASM Content Security Policy for ONNX Runtime WebAssembly
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'self'/);

  // Offscreen document & AI engine files exist
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'offscreen', 'offscreen.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'offscreen', 'offscreen.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'shared', 'ai-engine.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'shared', 'feedback-learner.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'horse-furigana', 'dist', 'index.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'horse-furigana', 'models', 'model.int8.onnx')));
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'onnxruntime-web', 'ort.wasm.min.mjs')));

  // Companion v2.0 compressed assets exist
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'pitch_map.json.gz')));
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'single_kanji.json.gz')));

  // Background service worker
  assert.equal(manifest.background?.type, 'module');
  const swPath = path.join(ROOT, manifest.background.service_worker);
  assert.ok(fs.existsSync(swPath), `Service worker missing: ${swPath}`);

  // Toolbar popup
  const popupPath = path.join(ROOT, manifest.action.default_popup);
  assert.ok(fs.existsSync(popupPath), `Popup HTML missing: ${popupPath}`);

  // Content scripts
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);
  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, ['<all_urls>']);
    assert.equal(cs.run_at, 'document_idle');
    assert.equal(cs.all_frames, true, 'Content script must support iframes via all_frames: true');
    for (const jsFile of cs.js) {
      const fullJsPath = path.join(ROOT, jsFile);
      assert.ok(fs.existsSync(fullJsPath), `Content script missing: ${fullJsPath}`);
    }
  }

  // Bundled dictionary & build script intact
  const dictFile = path.join(ROOT, 'data', 'dict.json.gz');
  const buildScript = path.join(ROOT, 'scripts', 'build_dict.py');
  assert.ok(fs.existsSync(dictFile), 'data/dict.json.gz must exist');
  assert.ok(fs.statSync(dictFile).size > 2_000_000, 'data/dict.json.gz should be ~2.56 MB');
  assert.ok(fs.existsSync(buildScript), 'scripts/build_dict.py must exist');

  // Verify build_dict.py uses https:// for all upstream URLs (no plaintext http:// URLs)
  const buildScriptSource = fs.readFileSync(buildScript, 'utf8');
  const urlConstants = [...buildScriptSource.matchAll(/^[A-Z0-9_]+_URL\s*=\s*"([^"]+)"/gm)].map(
    (m) => m[1]
  );
  assert.equal(urlConstants.length, 3, 'Expected 3 upstream dataset URL constants in build_dict.py');
  for (const u of urlConstants) {
    assert.match(u, /^https:\/\//, `Expected HTTPS upstream URL, got: ${u}`);
  }
});

test('Generated PNG icons exist and have valid PNG signatures and exact IHDR pixel dimensions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const expectedSizes = [16, 32, 48, 128];

  for (const size of expectedSizes) {
    const relIcon = manifest.icons[String(size)];
    assert.ok(relIcon, `manifest.icons["${size}"] must be defined`);
    const iconPath = path.join(ROOT, relIcon);
    assert.ok(fs.existsSync(iconPath), `Icon file missing: ${relIcon}`);

    const buf = fs.readFileSync(iconPath);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    assert.deepEqual(
      Array.from(buf.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${relIcon} must have valid PNG signature`
    );
    assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, size, `${relIcon} width must equal ${size}`);
    assert.equal(height, size, `${relIcon} height must equal ${size}`);
  }
});

test('Security & documentation: UI scripts never use innerHTML/outerHTML and attribution docs exist', () => {
  const uiScripts = [
    path.join(ROOT, 'src', 'content', 'content.js'),
    path.join(ROOT, 'src', 'popup', 'popup.js'),
    path.join(ROOT, 'src', 'background', 'service-worker.js'),
    path.join(ROOT, 'src', 'offscreen', 'offscreen.js'),
    path.join(ROOT, 'src', 'shared', 'ai-engine.js'),
    path.join(ROOT, 'src', 'shared', 'feedback-learner.js'),
    path.join(ROOT, 'src', 'shared', 'lookup.js'),
  ];

  for (const scriptPath of uiScripts) {
    const code = fs.readFileSync(scriptPath, 'utf8');
    assert.doesNotMatch(
      code,
      /\.\s*(innerHTML|outerHTML)\s*=/,
      `${path.basename(scriptPath)} must not assign innerHTML/outerHTML`
    );
    assert.doesNotMatch(
      code,
      /\binsertAdjacentHTML\b/,
      `${path.basename(scriptPath)} must not call insertAdjacentHTML`
    );
  }

  // Verify Horse Models Community License v2.0 attribution across UI and docs
  const popupHtml = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');
  const contentJs = fs.readFileSync(path.join(ROOT, 'src', 'content', 'content.js'), 'utf8');
  const attribution = fs.readFileSync(path.join(ROOT, 'ATTRIBUTION.md'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  for (const [label, content] of [
    ['popup.html', popupHtml],
    ['content.js', contentJs],
    ['ATTRIBUTION.md', attribution],
    ['README.md', readme],
  ]) {
    assert.match(content, /Powered by Horse Models/, `${label} must include "Powered by Horse Models"`);
    assert.match(
      content,
      /https:\/\/2008-horse\.com\/licensing\//,
      `${label} must link to https://2008-horse.com/licensing/`
    );
  }

  assert.match(attribution, /JMdict/);
  assert.match(attribution, /KANJIDIC2/);
  assert.match(attribution, /Kanjium/);
  assert.match(attribution, /CC BY-SA 4\.0/);
});
