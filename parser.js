// Достаем все списки сайтов антизапрета из любого хромиум движка, выгржается antizapret_sites_plain.txt, antizapret_hosts.json, pac_mods_full.json




const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const LS_KEY_MARK = 'pac-kitchen-mods';

function findProfile() {
  const home = os.homedir();
  const bases = [
    'Yandex\\YandexBrowser', 'YandexBrowser', 'Google\\Chrome', 'chromium', 'Chromium',
    'Vivaldi', 'BraveSoftware\\Brave-Browser', 'Epic Privacy Browser', 'Sputnik', 'Lingva',
  ].map(b => path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), b, 'User Data'))
    .concat([path.join(process.env.APPDATA || '', 'Yandex', 'YandexBrowser', 'User Data')]);
  const cands = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const prof of fs.readdirSync(base)) {
      const ls = path.join(base, prof, 'Local Storage', 'leveldb');
      if (fs.existsSync(ls)) cands.push({ leveldb: ls, label: prof });
    }
  }
  return cands;
}

function ensureClassicLevel(dir) {
  if (fs.existsSync(path.join(dir, 'node_modules', 'classic-level'))) return;
  console.log('Ставлю зависимость classic-level (нужен npm)...');
  execSync('npm init -y >nul 2>nul && npm install classic-level --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
}

function v8Decode(buf) {
  const pos = { i: 4 };
  function varint() { let v = 0n, s = 0n; while (true) { const b = buf[pos.i++]; v |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return v; }
  function str() {
    const n = Number(varint()); const isTwo = n & 1; const len = n >> 1;
    const raw = buf.subarray(pos.i, pos.i + len * (isTwo ? 2 : 1)); pos.i += raw.length;
    return raw.toString(isTwo ? 'utf16le' : 'latin1');
  }
  function val() {
    const t = buf[pos.i++];
    switch (t) {
      case 0x01: return null; case 0x02: return true; case 0x03: return false;
      case 0x04: { const d = Buffer.alloc(8); d.writeBigUInt64LE(varint()); return new Float64Array(d.buffer)[0]; }
      case 0x05: return Number(varint());
      case 0x08: case 0x0A: return str();
      case 0x20: { const o = {}; while (buf[pos.i] !== 0x01) { const k = val(); o[k] = val(); } pos.i++; return o; }
      case 0x21: { const a = []; while (buf[pos.i] !== 0x01) a.push(val()); pos.i++; return a; }
      default: throw new Error('V8 type 0x' + t.toString(16));
    }
  }
  return val();
}

function decode(buf) {
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && (buf[3] & 0x80) === 0) {
    try { return { kind: 'v8', data: v8Decode(buf) }; } catch (e) {}
  }
  const s = buf.toString('utf8');
  const t = s.replace(/^\x01+/, '').trimStart();
  if (t.startsWith('{')) { try { return { kind: 'json', data: JSON.parse(t) }; } catch (e) {} }
  return { kind: 'raw', data: s.replace(/^\x01+/, '') };
}

(async () => {
  const scriptDir = __dirname;
  ensureClassicLevel(scriptDir);
  const { ClassicLevel } = require('classic-level');

  let profiles = process.argv[2]
    ? [{ leveldb: path.join(process.argv[2], 'Local Storage', 'leveldb'), label: path.basename(process.argv[2]) }]
    : findProfile();
  if (!profiles.length) { console.log('Не найден профиль браузера (папка Local Storage\\leveldb). Укажи путь вручную: node extract.js "C:\\Users\\ВашЮзер\\AppData\\Local\\Yandex\\YandexBrowser\\User Data\\Default"'); process.exit(1); }

  const outDir = path.join(scriptDir, 'result');
  fs.mkdirSync(outDir, { recursive: true });
  let done = false;

  for (const prof of profiles) {
    const tmp = path.join(scriptDir, '_tmp_copy_' + prof.label);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of fs.readdirSync(prof.leveldb)) {
      if (f === 'LOCK') continue;
      try { fs.copyFileSync(path.join(prof.leveldb, f), path.join(tmp, f)); } catch (e) {}
    }
    const db = new ClassicLevel(tmp, { valueEncoding: 'buffer', keyEncoding: 'utf8', createIfMissing: false, readonly: true });
    let found = null, exts = new Set();
    try {
      await db.open();
      for await (const [key, value] of db.iterator()) {
        const ks = key.toString();
        if (!ks.includes('chrome-extension://')) continue;
        const m = ks.match(/chrome-extension:\/\/([a-z]{32})/); if (m) exts.add(m[1]);
        if (!ks.includes(LS_KEY_MARK)) continue;
        const dec = decode(value);
        const text = dec.kind === 'json' ? JSON.stringify(dec.data) : dec.data;
        try {
          const obj = typeof dec.data === 'object' ? dec.data : JSON.parse(String(text).replace(/^\x01+/, ''));
          if (obj && obj.exceptions) { found = obj; if (m) found.__extId = m[1]; break; }
        } catch (e) {}
      }
      await db.close();
    } catch (e) { console.log(prof.label, 'ERR', e.message); }
    fs.rmSync(tmp, { recursive: true, force: true });

    if (found) {
      const exc = found.exceptions || {};
      const inc = Object.keys(exc).filter(k => exc[k] !== false);
      const exl = Object.keys(exc).filter(k => exc[k] === false);
      const plain = inc.slice().sort((a, b) => (a > b ? -1 : 1));
      const hosts = [];
      const seen = new Set();
      for (const l of inc) {
        let h = l; while (h[0] === '*' || h[0] === '.') h = h.slice(1);
        if (h && !seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); hosts.push(h); }
      }
      hosts.sort((a, b) => (a > b ? -1 : 1));
      const jsonOut = hosts.map(h => ({ host: h, scope: 'domain', enabled: true, mode: 'proxy' }));
      fs.writeFileSync(path.join(outDir, 'antizapret_sites_plain.txt'), plain.join('\n'), 'utf8');
      fs.writeFileSync(path.join(outDir, 'antizapret_hosts.json'), JSON.stringify(jsonOut, null, 2), 'utf8');
      fs.writeFileSync(path.join(outDir, 'pac_mods_full.json'), JSON.stringify(found, null, 2), 'utf8');
      console.log('=============================');
      console.log('Профиль:', prof.label, '| расширение:', found.__extId);
      console.log('Проксируется сайтов:', inc.length, '| исключено:', exl.length, '| белый список:', (found.whitelist || []).length);
      if (found.customProxyStringRaw) console.log('Свой прокси:', found.customProxyStringRaw);
      console.log('Файлы в:', outDir);
      done = true;
      break;
    } else {
      console.log(prof.label, ': список не найден', exts.size ? '(расширений в localStorage: ' + exts.size + ')' : '(расширений в localStorage нет)');
    }
  }
  if (!done) console.log('Ни в одном профиле список не найден');
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
