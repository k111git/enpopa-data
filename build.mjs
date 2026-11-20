// Prepares the wind for the enpopa app: for each model, finds the newest complete run on
// Open-Meteo's open-data bucket, cuts the app's area out of every forecast hour, and writes
// one small file per hour plus a land mask and a manifest (latest.json) to site/, which the
// workflow publishes on GitHub Pages.
//
// File format (version 1), for each hour <model>/<run>/<valid>.bin:
//   raw deflate of, for each variable in turn, the int16 grid (ny rows south to north, nx
//   columns west to east, value = round(x * scale), nodata = -32768) coded as
//   d = v - (left + below - below-left)  (the left or below neighbour alone on the first
//   column/row, 0 at the corner), zigzag-mapped to uint16, low bytes of all cells then high bytes.
// mask.bin: raw deflate of ny * nx bytes, 1 = water.
//
// Usage: node build.mjs [site dir]   (default: site). Prints changed=true|false for the workflow.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BlockCacheBackend, LruBlockCache, OmDataType, OmFileReader, OmHttpBackend } from '@openmeteo/file-reader';

const SITE = path.resolve(process.argv[2] || 'site');
const S3_ROOT = 'https://openmeteo.s3.amazonaws.com';
const FORMAT = 1;
const SCALE = 10;          // 0.1 m/s
const NODATA = -32768;
const VARIABLES = ['wind_u_component_10m', 'wind_v_component_10m', 'wind_gusts_10m'];
// Must match WINDOW in the app's web/engine/models.js; the app checks rows and cols in the
// manifest and reads Open-Meteo directly when they differ.
const WINDOW = [38.4, 44.0, 0.0, 10.0];  // south, north, west, east
const KEEP_RUNS = 2;       // per model: the newest and the one before, for downloads in progress
const PARALLEL = 6;        // hours read at once

function model(def) {
  const { srcLat0, srcLon0, res, srcNy, srcNx } = def;
  const [s, n, w, e] = WINDOW;
  const rows = [Math.max(0, Math.round((s - srcLat0) / res)), Math.min(srcNy, Math.round((n - srcLat0) / res) + 1)];
  const cols = [Math.max(0, Math.round((w - srcLon0) / res)), Math.min(srcNx, Math.round((e - srcLon0) / res) + 1)];
  return { ...def, rows, cols, ny: rows[1] - rows[0], nx: cols[1] - cols[0] };
}

const MODELS = [
  model({ key: 'arome-hd', source: 'meteofrance_arome_france_hd', srcLat0: 37.5, srcLon0: -12.0, res: 0.01, srcNy: 1791, srcNx: 2801 }),
  model({ key: 'icon-eu', source: 'dwd_icon_eu', srcLat0: 29.5, srcLon0: -23.5, res: 0.0625, srcNy: 657, srcNx: 1377, runHours: [0, 6, 12, 18] }),
];

const pad = (n) => String(n).padStart(2, '0');
// 2026-11-20T06:00Z -> 20261120T0600Z, as the app builds file names too
export const stamp = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};
const parseTime = (s) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`) / 1000;
const runUrl = (m, run) => {
  const d = new Date(run * 1000);
  return `${S3_ROOT}/data_spatial/${m.source}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/`
    + `${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};
const omUrl = (m, run, valid) => {
  const d = new Date(valid * 1000);
  return `${runUrl(m, run)}/${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.om`;
};

async function retry(fn, tries = 4) {
  for (let k = 0; ; k++) {
    try { return await fn(); } catch (e) {
      if (k + 1 >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 3 ** k));
    }
  }
}

async function getJson(url, missingOk = false) {
  return retry(async () => {
    const r = await fetch(url, { cache: 'no-cache' });
    if (missingOk && (r.status === 403 || r.status === 404)) return null;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  });
}

const usable = (m, meta) => meta?.completed && VARIABLES.every((v) => meta.variables?.includes(v))
  && (!m.runHours || m.runHours.includes(new Date(parseTime(meta.reference_time) * 1000).getUTCHours()));

// newest complete run at one of the model's run hours (the same choice the app makes)
async function findRun(m) {
  let meta = await getJson(`${S3_ROOT}/data_spatial/${m.source}/latest.json`);
  let ref = parseTime(meta.reference_time);
  for (let back = 0; !usable(m, meta); back++) {
    if (back > 24) throw new Error(`no complete ${m.key} run found`);
    ref -= 3600;
    const hourOk = !m.runHours || m.runHours.includes(new Date(ref * 1000).getUTCHours());
    meta = hourOk ? await getJson(`${runUrl(m, ref)}/meta.json`, true) : null;
  }
  return { run: parseTime(meta.reference_time), times: meta.valid_times.map(parseTime), published: meta.last_modified_time };
}

// ---------------------------------------------------------------- reading .om files

const blocks = new LruBlockCache(128 << 10, 512);

async function withReader(url, fn) {
  const http = new OmHttpBackend({ url, eTagValidation: false });
  const backend = BlockCacheBackend.withStringKeys(http, blocks, url);
  http.fileSize = await backend.count();
  const reader = await OmFileReader.create(backend);
  try { return await fn(reader); } finally { reader.dispose(); }
}

let reading = 0;
const waiting = [];
async function slot(fn) {
  if (reading >= 3) await new Promise((r) => waiting.push(r));
  reading++;
  try { return await fn(); } finally { reading--; waiting.shift()?.(); }
}

async function readRange(v, rows, cols) {
  const ranges = [{ start: rows[0], end: rows[1] }, { start: cols[0], end: cols[1] }];
  await v.readPrefetch({ ranges });
  return slot(() => v.read({ type: OmDataType.FloatArray, ranges, prefetch: false }));
}

// float grids of the named variables (null: the file's root variable); a missing one is NaN
function readFields(url, names, rows, cols) {
  const size = (rows[1] - rows[0]) * (cols[1] - cols[0]);
  return retry(() => withReader(url, async (root) => {
    if (!names) return [await readRange(root, rows, cols)];
    return Promise.all(names.map(async (name) => {
      const v = await root.getChildByName(name);
      if (!v) return new Float32Array(size).fill(NaN);  // e.g. gusts at +0 h
      try { return await readRange(v, rows, cols); } finally { v.dispose(); }
    }));
  }));
}

// ---------------------------------------------------------------- encoding

export function encode(fields, ny, nx) {
  const n = ny * nx, out = new Uint8Array(fields.length * 2 * n);
  fields.forEach((f, p) => {
    const q = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      const v = f[k];
      q[k] = v === v ? Math.max(-32767, Math.min(32767, Math.round(v * SCALE))) : NODATA;
    }
    const base = p * 2 * n;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const k = y * nx + x;
        const pred = x && y ? q[k - 1] + q[k - nx] - q[k - nx - 1] : x ? q[k - 1] : y ? q[k - nx] : 0;
        const d = (q[k] - pred) << 16 >> 16;           // wraps to int16, as the decoder does
        const z = ((d << 1) ^ (d >> 15)) & 0xffff;     // zigzag
        out[base + k] = z & 255;
        out[base + n + k] = z >> 8;
      }
    }
  });
  return zlib.deflateRawSync(out, { level: 9 });
}

// ---------------------------------------------------------------- site

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeAtomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
};

async function buildModel(m, manifest) {
  const dir = path.join(SITE, m.key);
  let changed = false;

  const maskFile = path.join(dir, 'mask.bin');
  if (!fs.existsSync(maskFile)) {
    const [height] = await readFields(`${S3_ROOT}/data/${m.source}/static/HSURF.om`, null, m.rows, m.cols);
    const water = new Uint8Array(height.length);
    for (let k = 0; k < height.length; k++) water[k] = height[k] === -999 ? 1 : 0;  // Open-Meteo marks water as -999
    writeAtomic(maskFile, zlib.deflateRawSync(water, { level: 9 }));
    changed = true;
  }

  const { run, times, published } = await findRun(m);
  const runDir = path.join(dir, stamp(run));
  const entry = (manifest.models[m.key] ??= { runs: [] });
  if (!entry.runs.some((r) => r.run === run)) {
    const started = Date.now();
    let next = 0, bytes = 0;
    const work = async () => {
      while (next < times.length) {
        const t = times[next++], file = path.join(runDir, `${stamp(t)}.bin`);
        if (fs.existsSync(file)) { bytes += fs.statSync(file).size; continue; }  // left by a cut-short build
        const fields = await readFields(omUrl(m, run, t), VARIABLES, m.rows, m.cols);
        const buf = encode(fields, m.ny, m.nx);
        writeAtomic(file, buf);
        bytes += buf.length;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, work));
    console.error(`${m.key} ${stamp(run)}: ${times.length} hours, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1e3).toFixed(0)} s`);
    entry.runs.unshift({ run, times, published, bytes });
    changed = true;
  } else {
    console.error(`${m.key} ${stamp(run)}: up to date`);
  }

  entry.runs.sort((a, b) => b.run - a.run);
  entry.runs = entry.runs.slice(0, KEEP_RUNS);
  const keep = new Set(entry.runs.map((r) => stamp(r.run)));
  for (const name of fs.readdirSync(dir)) {
    if (/^\d{8}T\d{4}Z$/.test(name) && !keep.has(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      changed = true;
    }
  }
  Object.assign(entry, {
    rows: m.rows, cols: m.cols, ny: m.ny, nx: m.nx, variables: VARIABLES, scale: SCALE, nodata: NODATA, mask: 'mask.bin',
  });
  return changed;
}

async function main() {
  fs.mkdirSync(SITE, { recursive: true });
  const file = path.join(SITE, 'latest.json');
  const old = readJson(file);
  const manifest = old?.format === FORMAT ? old : { models: {} };
  let changed = !old || old.format !== FORMAT;
  const errors = [];
  for (const m of MODELS) {
    try {
      if (await buildModel(m, manifest)) changed = true;
    } catch (e) {
      errors.push(`${m.key}: ${e.message}`);  // the other model can still be published
      console.error(`${m.key} failed:`, e);
    }
  }
  if (changed) {
    writeAtomic(file, JSON.stringify({
      format: FORMAT,
      generated: new Date().toISOString(),
      attribution: 'Weather data by Open-Meteo.com (CC BY 4.0), from Météo-France AROME HD and DWD ICON-EU',
      ...manifest,
    }));
    fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
  }
  console.log(`changed=${changed}`);
  if (errors.length && !changed) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
