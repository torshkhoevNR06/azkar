'use strict';

/*
 * Азкар — сервер Mini App + бот.
 * - Отдаёт лендинг (../landing) на / и Mini App (../miniapp) на /app.
 * - API: /api/times (времена намаза по координатам+мазхабу), /api/location (регистрация
 *   геолокации пользователя для персональных напоминаний, с проверкой Telegram initData).
 * - Бот: /start (кнопка Mini App), /stop. Напоминания включаются при первом запуске Mini App:
 *     • у кого задана геолокация — по времени намаза (утренние после Фаджра, вечерние после Асра);
 *     • у кого нет геолокации, но есть таймзона — по фиксированному расписанию в его зоне;
 *     • без таймзоны бот ничего не угадывает и не шлёт.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const cron = require('node-cron');
const { spawn } = require('child_process');

// adhan v4 — ESM-only, грузим динамическим import (server.js — CommonJS)
let adhan = null;
import('adhan').then(m => { adhan = m.default || m; console.log('[adhan] загружен'); })
  .catch(e => console.error('[adhan] ошибка загрузки:', e));

const PORT = process.env.PORT || 3010;
const TOKEN = process.env.BOT_TOKEN || '';
function canonicalAppUrl(raw) {
  const url = new URL(String(raw || '').trim());
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}
// Telegram reuses an opened Mini App by its exact launch URL. Keep every bot entry point
// on the final, non-redirecting URL (/app/), even if APP_URL was configured as /app.
const APP_URL = canonicalAppUrl(process.env.APP_URL || 'https://azkar.nurtech.dev/app/');
const MORNING_CRON = process.env.MORNING_CRON || '30 6 * * *';
const EVENING_CRON = process.env.EVENING_CRON || '0 18 * * *';
const SLEEP_CRON = process.env.SLEEP_CRON || '30 22 * * *';
const TZ = process.env.TZ || 'Europe/Moscow';
const WELCOME_IMAGE = path.join(__dirname, 'assets', 'welcome.png');
const BOT_NAME = 'Азкар — поминания';
const BOT_SHORT_DESCRIPTION = 'Утренние, вечерние, перед сном и после намаза. Счётчик-тасбих, напоминания по времени намаза.';
const BOT_DESCRIPTION = `🕌 Азкар — утренние, вечерние, перед сном и азкары после намаза из достоверной Сунны.

• Читай список сверху вниз: арабский, транскрипция, перевод и источник
• Счётчик-тасбих — отмечай повторения касанием
• Есть поминания перед сном
• Напоминания приходят по времени твоего намаза (после Фаджра и Асра) и вечером перед сном
• Выбор мазхаба, светлая и тёмная тема

Нажми «Запустить», чтобы открыть приложение.`;
const BOT_COMMANDS = [
  { command: 'start', description: 'Открыть приложение' },
  { command: 'help', description: 'Как пользоваться' },
];
const WELCOME_CAPTION = `<b>Ассаляму алейкум 🌿</b>

Добро пожаловать в <b>Азкар</b> — приложение для утренних, вечерних, перед сном и азкаров после намаза.

Читайте список сверху вниз, отмечайте повторения счётчиком-тасбихом. Напоминания включатся при запуске приложения, их можно отключить в настройках.`;
const HELP_TEXT = `<b>Как пользоваться Азкаром</b>

1. Нажмите кнопку ниже, чтобы открыть приложение.
2. После запуска приложения напоминания включатся по таймзоне телефона. Их можно отключить в настройках.
3. Выберите мазхаб для расчёта времени.
4. Читайте азкары сверху вниз, а счётчик-тасбих отмечает повторения касанием.
5. Перед сном бот пришлёт отдельное спокойное напоминание.`;

// ---------- хранилище ----------
const DATA_FILE = path.join(__dirname, 'data', 'subscribers.json');
function loadSubs() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; } }
function saveSubs(s) { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2)); }
function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: tz }).format(new Date()); return true; }
  catch { return false; }
}
const TZ_APPROX_COORDS = {
  'Asia/Bishkek': { lat: 42.8746, lng: 74.5698, name: 'Бишкек' },
  'Asia/Almaty': { lat: 43.2389, lng: 76.8897, name: 'Алматы' },
  'Asia/Aqtau': { lat: 43.6532, lng: 51.1975, name: 'Актау' },
  'Asia/Aqtobe': { lat: 50.2839, lng: 57.1670, name: 'Актобе' },
  'Asia/Atyrau': { lat: 47.0945, lng: 51.9238, name: 'Атырау' },
  'Asia/Oral': { lat: 51.2278, lng: 51.3865, name: 'Уральск' },
  'Asia/Qostanay': { lat: 53.2144, lng: 63.6246, name: 'Костанай' },
  'Asia/Qyzylorda': { lat: 44.8488, lng: 65.4823, name: 'Кызылорда' },
  'Asia/Tashkent': { lat: 41.2995, lng: 69.2401, name: 'Ташкент' },
  'Asia/Samarkand': { lat: 39.6542, lng: 66.9597, name: 'Самарканд' },
  'Asia/Dushanbe': { lat: 38.5598, lng: 68.7870, name: 'Душанбе' },
  'Asia/Ashgabat': { lat: 37.9601, lng: 58.3261, name: 'Ашхабад' },
  'Europe/Moscow': { lat: 55.7558, lng: 37.6173, name: 'Москва' },
  'Europe/Minsk': { lat: 53.9006, lng: 27.5590, name: 'Минск' },
  'Europe/Kyiv': { lat: 50.4501, lng: 30.5234, name: 'Киев' },
  'Europe/Kiev': { lat: 50.4501, lng: 30.5234, name: 'Киев' },
  'Europe/Istanbul': { lat: 41.0082, lng: 28.9784, name: 'Стамбул' },
  'Asia/Yekaterinburg': { lat: 56.8389, lng: 60.6057, name: 'Екатеринбург' },
  'Asia/Omsk': { lat: 54.9885, lng: 73.3242, name: 'Омск' },
  'Asia/Novosibirsk': { lat: 55.0084, lng: 82.9357, name: 'Новосибирск' },
  'Asia/Barnaul': { lat: 53.3474, lng: 83.7784, name: 'Барнаул' },
  'Asia/Krasnoyarsk': { lat: 56.0153, lng: 92.8932, name: 'Красноярск' },
  'Asia/Irkutsk': { lat: 52.2864, lng: 104.2807, name: 'Иркутск' },
  'Asia/Yakutsk': { lat: 62.0355, lng: 129.6755, name: 'Якутск' },
  'Asia/Vladivostok': { lat: 43.1155, lng: 131.8855, name: 'Владивосток' },
  'Asia/Sakhalin': { lat: 46.9592, lng: 142.7380, name: 'Южно-Сахалинск' },
  'Asia/Kamchatka': { lat: 53.0370, lng: 158.6559, name: 'Петропавловск-Камчатский' },
  'Asia/Baku': { lat: 40.4093, lng: 49.8671, name: 'Баку' },
  'Asia/Tbilisi': { lat: 41.7151, lng: 44.8271, name: 'Тбилиси' },
  'Asia/Yerevan': { lat: 40.1872, lng: 44.5152, name: 'Ереван' },
  'Asia/Dubai': { lat: 25.2048, lng: 55.2708, name: 'Дубай' },
  'Asia/Riyadh': { lat: 24.7136, lng: 46.6753, name: 'Эр-Рияд' },
  'Asia/Qatar': { lat: 25.2854, lng: 51.5310, name: 'Доха' },
  'Asia/Kuwait': { lat: 29.3759, lng: 47.9774, name: 'Кувейт' },
  'Asia/Bahrain': { lat: 26.2235, lng: 50.5876, name: 'Манама' },
  'Asia/Muscat': { lat: 23.5880, lng: 58.3829, name: 'Маскат' },
  'Asia/Tehran': { lat: 35.6892, lng: 51.3890, name: 'Тегеран' },
  'Asia/Karachi': { lat: 24.8607, lng: 67.0011, name: 'Карачи' },
  'Asia/Kabul': { lat: 34.5553, lng: 69.2075, name: 'Кабул' },
  'Asia/Dhaka': { lat: 23.8103, lng: 90.4125, name: 'Дакка' },
  'Asia/Jakarta': { lat: -6.2088, lng: 106.8456, name: 'Джакарта' },
  'Asia/Kuala_Lumpur': { lat: 3.1390, lng: 101.6869, name: 'Куала-Лумпур' },
  'Asia/Singapore': { lat: 1.3521, lng: 103.8198, name: 'Сингапур' },
};
function timezoneOffsetHours(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date);
    const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
    const m = name.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    const hours = Number(m[2]) + (Number(m[3] || 0) / 60);
    return (m[1] === '-' ? -1 : 1) * hours;
  } catch { return null; }
}
function approxCoordsForTz(tz) {
  const exact = TZ_APPROX_COORDS[tz];
  if (exact) return exact;
  const offset = timezoneOffsetHours(tz);
  if (!Number.isFinite(offset)) return null;
  return { lat: 30, lng: Math.max(-180, Math.min(180, offset * 15)), name: 'ваша таймзона' };
}

// ---------- расчёт времён намаза ----------
function prayerTimes(lat, lng, madhab, date) {
  if (!adhan) throw new Error('adhan not loaded yet');
  const coords = new adhan.Coordinates(Number(lat), Number(lng));
  const params = adhan.CalculationMethod.MuslimWorldLeague();
  params.madhab = madhab === 'hanafi' ? adhan.Madhab.Hanafi : adhan.Madhab.Shafi;
  return new adhan.PrayerTimes(coords, date || new Date(), params);
}

// ---------- статик + API ----------
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// времена намаза на сегодня (ISO в UTC — клиент форматирует в свою зону)
app.get('/api/times', (req, res) => {
  const { lat, lng, madhab } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });
  if (!adhan) return res.status(503).json({ error: 'prayer engine warming up' });
  try {
    const t = prayerTimes(lat, lng, madhab, new Date());
    res.json({
      fajr: t.fajr, sunrise: t.sunrise, dhuhr: t.dhuhr,
      asr: t.asr, maghrib: t.maghrib, isha: t.isha,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// примерные времена намаза по таймзоне, если пользователь ещё не дал геолокацию
app.get('/api/approx-times', (req, res) => {
  const { tz, madhab } = req.query;
  if (!validTimeZone(tz)) return res.status(400).json({ error: 'bad tz' });
  if (!adhan) return res.status(503).json({ error: 'prayer engine warming up' });
  const approx = approxCoordsForTz(tz);
  if (!approx) return res.status(404).json({ error: 'approx location not found' });
  try {
    const t = prayerTimes(approx.lat, approx.lng, madhab, new Date());
    res.json({
      approx: true, city: approx.name,
      fajr: t.fajr, sunrise: t.sunrise, dhuhr: t.dhuhr,
      asr: t.asr, maghrib: t.maghrib, isha: t.isha,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// проверка подписи Telegram WebApp initData
function checkInitData(initData) {
  if (!initData || !TOKEN) return null;
  const url = new URLSearchParams(initData);
  const hash = url.get('hash');
  url.delete('hash');
  const dcs = [...url.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc !== hash) return null;
  try { return JSON.parse(url.get('user')); } catch { return null; }
}

// регистрация геолокации пользователя (для персональных напоминаний)
app.post('/api/location', (req, res) => {
  const { initData, lat, lng, madhab, tz } = req.body || {};
  const user = checkInitData(initData);
  if (!user || !user.id) return res.status(401).json({ error: 'bad initData' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required' });
  const subs = loadSubs();
  const prev = subs[user.id] || {};
  subs[user.id] = { ...prev, id: user.id, name: user.first_name || '',
    lat, lng, madhab: madhab === 'hanafi' ? 'hanafi' : 'shafi',
    tz: validTimeZone(tz) ? tz : prev.tz,
    remindersEnabled: prev.manualDisabled === true ? false : true,
    since: prev.since || Date.now() };
  saveSubs(subs);
  res.json({ ok: true });
});

// регистрация таймзоны при запуске Mini App. Это включает напоминания, если пользователь сам их не выключал.
app.post('/api/tz', (req, res) => {
  const { initData, tz } = req.body || {};
  const user = checkInitData(initData);
  if (!user || !user.id) return res.status(401).json({ error: 'bad initData' });
  if (!validTimeZone(tz)) return res.status(400).json({ error: 'bad tz' });
  const subs = loadSubs();
  const prev = subs[user.id] || {};
  subs[user.id] = {
    ...prev,
    id: user.id,
    name: user.first_name || prev.name || '',
    tz,
    remindersEnabled: prev.manualDisabled === true ? false : true,
    since: prev.since || Date.now(),
  };
  saveSubs(subs);
  res.json({ ok: true, remindersEnabled: subs[user.id].remindersEnabled });
});

// явное включение/выключение напоминаний из Mini App
app.post('/api/reminders', (req, res) => {
  const { initData, enabled, tz, lat, lng, madhab } = req.body || {};
  const user = checkInitData(initData);
  if (!user || !user.id) return res.status(401).json({ error: 'bad initData' });
  const subs = loadSubs();
  const prev = subs[user.id] || {};
  const next = { ...prev, id: user.id, name: user.first_name || prev.name || '', since: prev.since || Date.now() };
  if (validTimeZone(tz)) next.tz = tz;
  if (typeof lat === 'number' && typeof lng === 'number') {
    next.lat = lat;
    next.lng = lng;
    next.madhab = madhab === 'hanafi' ? 'hanafi' : 'shafi';
  }
  if (enabled === true && !validTimeZone(next.tz)) return res.status(400).json({ error: 'tz required' });
  next.remindersEnabled = enabled === true;
  next.manualDisabled = enabled !== true;
  subs[user.id] = next;
  saveSubs(subs);
  res.json({ ok: true, remindersEnabled: next.remindersEnabled });
});

// прогресс заучивания/чтения Корана — чтобы бот мог напоминать о повторениях
app.post('/api/hifz', (req, res) => {
  const { initData, khatm, read, mem, srs, totAy, totSec, tz } = req.body || {};
  const user = checkInitData(initData);
  if (!user || !user.id) return res.status(401).json({ error: 'bad initData' });
  const subs = loadSubs();
  const prev = subs[user.id] || {};
  const next = { ...prev, id: user.id, name: user.first_name || prev.name || '', since: prev.since || Date.now() };
  if (validTimeZone(tz)) next.tz = next.tz || tz;
  let srsClean = {};
  if (srs && typeof srs === 'object') { let n = 0; for (const k in srs) { if (n++ > 300) break; const v = srs[k]; if (v && typeof v.i === 'number' && typeof v.d === 'number') srsClean[k] = { i: v.i | 0, d: v.d | 0 }; } }
  next.hifz = {
    khatm: Number(khatm) || 0,
    read: (typeof read === 'string' && read.length < 4000) ? read : (prev.hifz && prev.hifz.read) || '',
    mem: (typeof mem === 'string' && mem.length < 4000) ? mem : (prev.hifz && prev.hifz.mem) || '',
    srs: srsClean,
    totAy: Number(totAy) || 0,
    totSec: Number(totSec) || 0,
    updated: Date.now(),
  };
  subs[user.id] = next;
  saveSubs(subs);
  res.json({ ok: true });
});

// ---------- радио: один общий ffmpeg раздаёт mp3 всем ----------
// Радио: каждая станция выбирается отдельно. Старые channel=ar/ru оставлены как алиасы.
const RADIO_URL = process.env.RADIO_URL || 'https://www.youtube.com/@bmagrifa/live';
const RADIO_STATIONS = [
  { id: 'saudi-quran', group: 'ar', title: 'إذاعة القرآن الكريم', subtitle: 'Saudi Radio / SBA', sources: ['https://live.kwikmotion.com/sbrksaquranradiolive/ksaquranradio/playlist.m3u8'] },
  { id: 'saudi-nida', group: 'ar', title: 'إذاعة نداء الإسلام', subtitle: 'Saudi Radio / SBA', sources: ['https://live.kwikmotion.com/sbrksanedaradiolive/ksanedaradio/playlist.m3u8'] },
  { id: 'qurango-tarateel', group: 'ar', title: 'Qurango Tarateel', subtitle: 'MP3Quran / Qurango', sources: ['https://Qurango.net/radio/tarateel'] },
  { id: 'radio-quraan', group: 'ar', title: 'Radio Quraan', subtitle: 'radioquraan.com', sources: ['http://66.45.232.131:9994/stream'] },
  { id: 'alseraj-radio', group: 'ar', title: 'Alseraj Radio', subtitle: 'alserajradio.com', sources: ['http://192.99.170.8:5550/stream'] },
  { id: 'quran-tafsir', group: 'ar', title: 'Radio Quran Tafsir', subtitle: 'quranradiotafsir.com', sources: ['http://66.45.232.131:9992/stream'] },
  { id: 'eman-city', group: 'ar', title: 'Eman City', subtitle: 'emancity.com', sources: ['http://66.45.232.131:9990/stream'] },
  { id: 'bmagrifa-ru', group: 'ru', title: 'Русский эфир', subtitle: 'Слушать на русском', sources: [RADIO_URL].filter(Boolean) },
];
function splitEnvList(v) {
  return String(v || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}
function isYoutubeUrl(url) { return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\b/i.test(String(url || '')); }
function uniqList(list) { return list.filter((url, idx, arr) => url && arr.indexOf(url) === idx); }
function radioStationId(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['ru', 'rus', 'russian', 'рус', 'русский'].includes(v)) return 'bmagrifa-ru';
  if (['ar', 'arabic', 'арабский', 'араб'].includes(v)) return 'saudi-quran';
  return RADIO_STATIONS.some(st => st.id === v) ? v : 'saudi-quran';
}
function radioStation(id) {
  const stationId = radioStationId(id);
  return RADIO_STATIONS.find(st => st.id === stationId) || RADIO_STATIONS[0];
}
function radioSourcesFor(station) {
  const st = radioStation(station);
  return uniqList(st.sources.concat(splitEnvList(process.env.RADIO_EXTRA_STREAMS)));
}
// PO-token провайдер (bgutil) — обход антибот-проверки YouTube с дата-центрового IP.
// Пустая строка POT_PROVIDER_URL отключает провайдер (например, при переходе на куки).
const POT_PROVIDER_URL = ('POT_PROVIDER_URL' in process.env) ? process.env.POT_PROVIDER_URL : 'http://bgutil-provider:4416';
// Куки залогиненного YouTube-аккаунта (Netscape cookies.txt) — обязательны на зафлаганном
// дата-центровом IP: без них YouTube отдаёт LOGIN_REQUIRED ещё до стадии PO-токена.
// Файл лежит в томе данных (переживает пересборку, НЕ в образе/гите). Положить: /opt/azkar -> volume.
const YT_COOKIES = process.env.YT_COOKIES || path.join(__dirname, 'data', 'cookies.txt');
function radioHasCookies() { try { return !!YT_COOKIES && fs.existsSync(YT_COOKIES); } catch { return false; } }
function ytdlpArgs(url = RADIO_URL) {
  // --js-runtimes node: включить node как JS-раннер для решения n-challenge (deno по умолчанию,
  // но его нет в alpine; node>=22 в образе поддерживается). yt-dlp-ejs даёт solver-скрипты.
  const a = ['-f', 'bestaudio/best', '-g', '--no-warnings', '--no-playlist', '--js-runtimes', 'node'];
  if (radioHasCookies()) a.push('--cookies', YT_COOKIES);
  if (POT_PROVIDER_URL) a.push('--extractor-args', 'youtubepot-bgutilhttp:base_url=' + POT_PROVIDER_URL);
  a.push(url);
  return a;
}
const radios = new Map();
function createRadioState(station) {
  const st = radioStation(station);
  return { station: st.id, group: st.group, title: st.title, subtitle: st.subtitle, proc: null, clients: new Set(), tail: [], starting: false, idleTimer: null, lastOk: 0, failCount: 0, source: '', sources: radioSourcesFor(st.id) };
}
function getRadio(station) {
  const id = radioStationId(station);
  if (!radios.has(id)) radios.set(id, createRadioState(id));
  return radios.get(id);
}
function radioStatus(r) {
  return { id: r.station, group: r.group, title: r.title, subtitle: r.subtitle, live: !!r.proc, listeners: r.clients.size, source: r.source || '', sources: r.sources.length, lastOk: r.lastOk || 0, fails: r.failCount || 0 };
}
function radioStationsStatus() {
  return RADIO_STATIONS.map(st => radioStatus(getRadio(st.id)));
}
// yt-dlp при успешном резолве ПЕРЕЗАПИСЫВАЕТ cookies.txt свежими (ротированными) куками — так
// сессия YouTube живёт, пока эфир регулярно резолвится. Держим бэкап, чтобы битый прогон не затёр рабочие.
const YT_COOKIES_BAK = YT_COOKIES + '.bak';
function cookieBackup() { try { if (radioHasCookies()) fs.copyFileSync(YT_COOKIES, YT_COOKIES_BAK); } catch {} }
function cookieRestore() { try { if (fs.existsSync(YT_COOKIES_BAK)) fs.copyFileSync(YT_COOKIES_BAK, YT_COOKIES); } catch {} }
// алерт владельцу (опц., env RADIO_ALERT_CHAT_ID): все источники эфира не поднимаются
const RADIO_ALERT_CHAT_ID = process.env.RADIO_ALERT_CHAT_ID || '';
let _radioAlertedAt = 0;
function radioAlert(err) {
  if (!RADIO_ALERT_CHAT_ID || !TOKEN) return;
  const now = Date.now(); if (now - _radioAlertedAt < 6 * 3600 * 1000) return; _radioAlertedAt = now;   // не спамить (≤1/6ч)
  const text = '⚠️ Радио: не удаётся поднять эфир ни с одного источника.\n' + String((err && err.message) || err).slice(0, 200);
  try { fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: RADIO_ALERT_CHAT_ID, text }) }).catch(() => {}); } catch {}
}
function radioResolve(url = RADIO_URL) {
  return new Promise((resolve, reject) => {
    if (radioHasCookies()) cookieBackup();
    const yt = spawn('yt-dlp', ytdlpArgs(url));
    let out = '', err = '';
    yt.stdout.on('data', (d) => (out += d));
    yt.stderr.on('data', (d) => (err += d));
    yt.on('error', (e) => { cookieRestore(); reject(e); });
    const to = setTimeout(() => { try { yt.kill('SIGKILL'); } catch {} cookieRestore(); reject(new Error('yt-dlp timeout')); }, 25000);
    yt.on('close', (code) => { clearTimeout(to); const url = out.trim().split('\n')[0];
      if (code === 0 && url) { cookieBackup(); resolve(url); }              // успех: сохранить свежий бэкап
      else { cookieRestore(); reject(new Error('yt-dlp ' + code + ': ' + err.slice(0, 160))); } });
  });
}
// несколько попыток с backoff — переживать разовые сбои резолва/сети
async function radioResolveRetry(tries, url = RADIO_URL) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await radioResolve(url); }
    catch (e) { lastErr = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw lastErr;
}
function radioWriteChunk(r, chunk) {
  r.tail.push(chunk);
  let total = r.tail.reduce((s, c) => s + c.length, 0);
  while (total > 96 * 1024 && r.tail.length > 1) total -= r.tail.shift().length;
  for (const res of r.clients) { try { res.write(chunk); } catch {} }
}
async function radioSourceUrl(source) {
  if (isYoutubeUrl(source)) return radioResolveRetry(2, source);
  return source;
}
function radioSpawn(r, sourceLabel, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let noAudioTimer = null;
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-rw_timeout', '12000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'
    ]);
    function fail(err) {
      if (settled) return;
      settled = true;
      if (noAudioTimer) clearTimeout(noAudioTimer);
      try { ff.kill('SIGKILL'); } catch {}
      reject(err);
    }
    noAudioTimer = setTimeout(() => fail(new Error('ffmpeg no audio from ' + sourceLabel)), 12000);
    ff.stdout.on('data', (chunk) => {
      radioWriteChunk(r, chunk);
      if (!settled) {
        settled = true;
        if (noAudioTimer) clearTimeout(noAudioTimer);
        r.proc = ff;
        r.source = sourceLabel;
        r.lastOk = Date.now();
        r.failCount = 0;
        console.log('[radio] source ok:', r.station, sourceLabel);
        resolve(ff);
      }
    });
    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-800); });
    ff.on('close', (code) => {
      if (!settled) {
        fail(new Error('ffmpeg close ' + code + ' from ' + sourceLabel + ': ' + stderr.slice(-180)));
        return;
      }
      if (r.proc === ff) {
        r.proc = null;
        r.tail = [];
        r.source = '';
        if (r.clients.size) setTimeout(() => radioStart(r.station), 1200);
      }
    });
    ff.on('error', (e) => {
      if (!settled) fail(e);
      else if (r.proc === ff) { r.proc = null; r.tail = []; r.source = ''; }
    });
  });
}
async function radioStart(station = 'saudi-quran') {
  const r = getRadio(station);
  if (r.proc || r.starting) return;
  r.starting = true;
  try {
    let lastErr = null;
    for (const source of r.sources) {
      const sourceLabel = isYoutubeUrl(source) ? 'youtube:' + source : source;
      try {
        const url = await radioSourceUrl(source);
        await radioSpawn(r, sourceLabel, url);
        return;
      } catch (e) {
        lastErr = e;
        console.warn('[radio] source failed:', r.station, sourceLabel, e.message);
        r.proc = null;
        r.tail = [];
        r.source = '';
      }
    }
    throw lastErr || new Error('no radio sources configured');
  } catch (e) {
    console.warn('[radio] не удалось запустить эфир:', r.station, e.message);
    r.proc = null; r.tail = []; r.source = ''; r.failCount = (r.failCount || 0) + 1; radioAlert(e);
    for (const res of r.clients) { try { res.end(); } catch {} }
    r.clients.clear();
  } finally { r.starting = false; }
}
function radioStopIfIdle(r) {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  r.idleTimer = setTimeout(() => {
    if (r.clients.size === 0 && r.proc) { try { r.proc.kill('SIGKILL'); } catch {} r.proc = null; r.tail = []; r.source = ''; }
  }, 20000);
}
// keep-alive кук: периодически тихо резолвим эфир, чтобы yt-dlp освежил куки (write-back) и сессия
// YouTube не протухла от простоя — работает и без слушателей. Только в простое (идёт эфир → куки и так свежие).
const RADIO_KEEPALIVE_CRON = process.env.RADIO_KEEPALIVE_CRON || '17 */4 * * *';   // каждые 4 часа
async function radioKeepAlive(reason) {
  const ru = getRadio('bmagrifa-ru');
  if (!radioHasCookies() || ru.starting || ru.proc) return;
  try { await radioResolve(RADIO_URL); ru.lastOk = Date.now(); ru.failCount = 0; console.log('[radio] keep-alive ok (' + reason + '): куки освежены'); }
  catch (e) { console.warn('[radio] keep-alive FAIL (' + reason + '):', e.message); }
}
try { cron.schedule(RADIO_KEEPALIVE_CRON, () => radioKeepAlive('cron'), { timezone: TZ }); }
catch (e) { console.warn('[radio] keep-alive cron не запланирован:', e.message); }
setTimeout(() => radioKeepAlive('boot'), 60000);   // прогрев + самопроверка через минуту после старта
app.get('/api/radio/stream', (req, res) => {
  const station = radioStationId(req.query.station || req.query.channel);
  const r = getRadio(station);
  if (r.clients.size >= 30) return res.status(503).end('busy');
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': '*' });
  r.clients.add(res);
  for (const c of r.tail) { try { res.write(c); } catch {} }
  radioStart(station);
  req.on('close', () => { r.clients.delete(res); radioStopIfIdle(r); });
});
app.get('/api/radio/status', (req, res) => {
  const selected = radioStationId(req.query.station || req.query.channel);
  const r = getRadio(selected);
  res.json({
    ...radioStatus(r),
    selected,
    cookies: radioHasCookies(),
    pot: !!POT_PROVIDER_URL,
    stations: radioStationsStatus(),
  });
});

// Аудио аскаров: same-origin прокси к hisnmuslim (Telegram WKWebView не тянет чужой домен напрямую).
app.get('/api/azkar-audio/:n', (req, res) => {
  const n = String(req.params.n || '').replace(/[^0-9]/g, '');
  if (!n) { res.status(400).end(); return; }
  const headers = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' };
  if (req.headers.range) headers.Range = req.headers.range;
  const up = https.request(
    { host: 'www.hisnmuslim.com', path: '/audio/ar/' + n + '.mp3', method: 'GET', headers },
    (r) => {
      const h = {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=604800',
        'Access-Control-Allow-Origin': '*',
      };
      if (r.headers['content-length']) h['Content-Length'] = r.headers['content-length'];
      if (r.headers['content-range']) h['Content-Range'] = r.headers['content-range'];
      res.writeHead(r.statusCode || 200, h);
      r.pipe(res);
    }
  );
  up.on('error', () => { try { res.status(502).end(); } catch {} });
  up.setTimeout(20000, () => { try { up.destroy(); } catch {} });
  req.on('close', () => { try { up.destroy(); } catch {} });
  up.end();
});

const QUL_MUSHAF_LAYOUT_ID = '569';
const QUL_MUSHAF_CACHE_DIR = process.env.QUL_MUSHAF_CACHE_DIR || path.join(__dirname, 'data', 'qul-mushaf-svg');
const qulMushafInflight = new Map();
function httpsText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Azkar Nurtech; QUL Mushaf SVG cache)',
        Accept: 'text/html,application/xhtml+xml,image/svg+xml,*/*',
        ...headers,
      },
    }, (r) => {
      if ((r.statusCode || 0) < 200 || (r.statusCode || 0) >= 300) {
        r.resume();
        reject(new Error('upstream ' + r.statusCode));
        return;
      }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (chunk) => { body += chunk; });
      r.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
function extractQulMushafSvg(html, page) {
  const id = String(page).padStart(3, '0');
  const direct = new RegExp(`<svg\\b[^>]*id=["']Mushaf_Page_${id}["'][\\s\\S]*?<\\/svg>`, 'i').exec(html);
  const svg = direct ? direct[0] : (/<svg\b[^>]*data-md-version=["'][^"']+["'][\s\S]*?<\/svg>/i.exec(html) || [null])[0];
  if (!svg || !svg.includes('md-page')) return null;
  return svg.replace(/\sdata-controller=["'][^"']*["']/gi, '');
}
function fitQulMushafSvg(svg) {
  let out = String(svg);
  ['md-non-quranic-header-surah-name', 'md-non-quranic-header-juz-name', 'md-non-quranic-page-number', 'md-non-quranic-margin-juz-hisb'].forEach((id) => {
    out = stripSvgGroupById(out, id);
  });
  return out.replace(/\bviewBox=["']0 0 382\.68 547\.09["']/, 'viewBox="-18 0 418.68 547.09"');
}
function stripSvgGroupById(svg, id) {
  const start = new RegExp(`<g\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`, 'i').exec(svg);
  if (!start) return svg;
  const group = /<\/?g\b[^>]*>/gi;
  group.lastIndex = start.index + start[0].length;
  let depth = 1;
  let token;
  while (depth > 0 && (token = group.exec(svg))) {
    depth += token[0][1] === '/' ? -1 : 1;
  }
  if (depth !== 0) return svg;
  return svg.slice(0, start.index) + svg.slice(group.lastIndex);
}
async function loadQulMushafSvg(page, cacheFile) {
  try {
    return { svg: await fs.promises.readFile(cacheFile, 'utf8'), source: 'QUL cache' };
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  if (qulMushafInflight.has(page)) return qulMushafInflight.get(page);
  const pending = (async () => {
    const url = 'https://qul.tarteel.ai/resources/mushaf-layout/' + QUL_MUSHAF_LAYOUT_ID + '?page=' + page;
    const html = await httpsText(url);
    const svg = extractQulMushafSvg(html, page);
    if (!svg) throw new Error('svg not found');
    await fs.promises.mkdir(QUL_MUSHAF_CACHE_DIR, { recursive: true });
    await fs.promises.writeFile(cacheFile, svg);
    return { svg, source: 'QUL' };
  })();
  qulMushafInflight.set(page, pending);
  try { return await pending; }
  finally { qulMushafInflight.delete(page); }
}
function gzipBuffer(data) {
  return new Promise((resolve, reject) => {
    zlib.gzip(data, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (err, out) => err ? reject(err) : resolve(out));
  });
}
function stripQuranTextLines(svg) {
  const start = /<g\b(?=[^>]*\bid=["']md-line-\d+["'])(?=[^>]*\bdata-type=["']text["'])[^>]*>/gi;
  const group = /<\/?g\b[^>]*>/gi;
  let cursor = 0;
  let output = '';
  let match;
  while ((match = start.exec(svg))) {
    output += svg.slice(cursor, match.index);
    group.lastIndex = start.lastIndex;
    let depth = 1;
    let token;
    while (depth > 0 && (token = group.exec(svg))) {
      depth += token[0][1] === '/' ? -1 : 1;
    }
    if (depth !== 0) throw new Error('malformed QUL SVG groups');
    cursor = group.lastIndex;
    start.lastIndex = cursor;
  }
  return (output + svg.slice(cursor)).replace('<svg ', '<svg data-tajweed-shell="true" ');
}
async function loadQulMushafShell(cacheFile, loaded) {
  const shellFile = cacheFile.replace(/\.svg$/, '.shell.svg');
  try {
    return { svg: await fs.promises.readFile(shellFile, 'utf8'), source: loaded.source + ' shell', cacheFile: shellFile };
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  const svg = stripQuranTextLines(loaded.svg);
  await fs.promises.writeFile(shellFile, svg);
  return { svg, source: loaded.source + ' shell', cacheFile: shellFile };
}
async function sendQulMushafSvg(req, res, cacheFile, loaded) {
  const gzipOk = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  let body = Buffer.from(fitQulMushafSvg(loaded.svg));
  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Vary': 'Accept-Encoding',
    'X-Mushaf-Source': loaded.source,
  });
  if (gzipOk) {
    const gzipFile = cacheFile + '.fit-v5.gz';
    try { body = await fs.promises.readFile(gzipFile); }
    catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      body = await gzipBuffer(body);
      fs.promises.writeFile(gzipFile, body).catch(() => {});
    }
    res.set('Content-Encoding', 'gzip');
  }
  res.send(body);
}
app.get('/api/mushaf-svg/:page', async (req, res) => {
  const page = parseInt(req.params.page, 10);
  if (!(page >= 1 && page <= 604)) { res.status(400).end(); return; }
  const id = String(page).padStart(3, '0');
  const cacheFile = path.join(QUL_MUSHAF_CACHE_DIR, id + '.svg');
  try {
    let loaded = await loadQulMushafSvg(page, cacheFile);
    let responseFile = cacheFile;
    if (req.query.shell === '1') {
      loaded = await loadQulMushafShell(cacheFile, loaded);
      responseFile = loaded.cacheFile;
    }
    await sendQulMushafSvg(req, res, responseFile, loaded);
  } catch (e) {
    console.error('[qul-mushaf-svg]', page, e && e.message ? e.message : e);
    res.status(502).json({ ok: false, error: 'QUL SVG unavailable' });
  }
});

// Mini App живёт под /app, лендинг — на корне. API и health объявлены выше.
app.use('/app', express.static(path.join(__dirname, '..', 'miniapp'), { extensions: ['html'], index: 'index.html' }));
app.use('/', express.static(path.join(__dirname, '..', 'landing'), { extensions: ['html'], index: 'index.html' }));

app.listen(PORT, () => console.log(`[web] Mini App + API на :${PORT}`));

// ---------- бот ----------
if (!TOKEN) {
  console.warn('[bot] BOT_TOKEN не задан — только статик/API, бот выключен.');
} else {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(TOKEN, { polling: true });
  const kb = { reply_markup: { inline_keyboard: [[{ text: '🕌 Открыть азкары', web_app: { url: APP_URL } }]] } };
  async function botApi(method, payload) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.description || `${method} failed`);
    return json.result;
  }
  async function applyBotBranding() {
    const steps = [
      ['menu button', () => botApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Азкары', web_app: { url: APP_URL } } })],
      ['name', () => bot.setMyName({ name: BOT_NAME })],
      ['short description', () => bot.setMyShortDescription({ short_description: BOT_SHORT_DESCRIPTION })],
      ['description', () => bot.setMyDescription({ description: BOT_DESCRIPTION })],
      ['commands', () => bot.setMyCommands(BOT_COMMANDS)],
    ];
    for (const [label, run] of steps) {
      try { await run(); }
      catch (e) { console.warn(`[bot] ${label} не применился:`, e?.message || e); }
    }
  }
  applyBotBranding();

  bot.onText(/\/start/, (msg) => {
    const id = msg.chat.id, subs = loadSubs();
    if (subs[id]) {
      subs[id] = { ...subs[id], id, name: msg.from.first_name || subs[id].name || '' };
      saveSubs(subs);
    }
    bot.sendPhoto(id, WELCOME_IMAGE, { caption: WELCOME_CAPTION, parse_mode: 'HTML', ...kb })
      .catch((e) => {
        console.warn('[bot] welcome photo не отправилось:', e?.message || e);
        return bot.sendMessage(id, WELCOME_CAPTION, { parse_mode: 'HTML', ...kb });
      });
  });
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML', ...kb });
  });
  bot.onText(/\/stop/, (msg) => {
    const s = loadSubs();
    if (s[msg.chat.id]) { s[msg.chat.id].remindersEnabled = false; s[msg.chat.id].manualDisabled = true; saveSubs(s); }
    bot.sendMessage(msg.chat.id, 'Напоминания отключены. Чтобы включить снова, открой приложение и включи их в настройках.');
  });

  function send(id, text) {
    bot.sendMessage(id, text, kb).catch((e) => {
      if (e?.response?.statusCode === 403) { const s = loadSubs(); delete s[id]; saveSubs(s); }
    });
  }
  const MORNING_MSG = '🌅 Время утренних поминаний. Начни день с зикра.';
  const EVENING_MSG = '🌙 Время вечерних поминаний.';
  const SLEEP_MSG = '🌙 Поминания перед сном. Закрой день спокойно — открой раздел «Перед сном».';
  function hhmm(d, tz) { return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz || TZ }); }
  function localDay(d, tz) { return d.toLocaleDateString('sv-SE', { timeZone: tz || TZ }); }   // YYYY-MM-DD в зоне пользователя
  function cronToHM(expr) { const p = String(expr).trim().split(/\s+/); const h = +p[1], m = +p[0]; return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
  const FIXED = { morning: cronToHM(MORNING_CRON), evening: cronToHM(EVENING_CRON), sleep: cronToHM(SLEEP_CRON) };
  const HIFZ_HM = process.env.HIFZ_TIME || '09:00';   // время напоминания о повторении (в зоне пользователя)
  function popcountB64(b64) { try { const bin = Buffer.from(b64 || '', 'base64'); let c = 0; for (let i = 0; i < bin.length; i++) { let b = bin[i]; while (b) { c += b & 1; b >>= 1; } } return c; } catch { return 0; } }
  function pluralN(n, a, b, c) { n = Math.abs(n); const d = n % 100, e = n % 10; if (d > 10 && d < 20) return c; if (e > 1 && e < 5) return b; if (e === 1) return a; return c; }
  function weekdayInTz(now, tz) { try { return new Date(now.toLocaleString('en-US', { timeZone: tz || TZ })).getDay(); } catch { return now.getDay(); } }

  // единый поминутный тик: КАЖДОМУ в ЕГО таймзоне (u.tz), дедуп по локальному дню пользователя
  cron.schedule('* * * * *', () => {
    const subs = loadSubs(); const now = new Date(); let changed = false;
    for (const id in subs) {
      const u = subs[id];
      if (u.remindersEnabled !== true) continue;
      const tz = validTimeZone(u.tz) ? u.tz : '';
      if (!tz) continue;
      const day = localDay(now, tz);
      const nowHM = hhmm(now, tz);
      let t = null;
      if (typeof u.lat === 'number' && typeof u.lng === 'number') {
        // точные — по геолокации пользователя
        try { t = prayerTimes(u.lat, u.lng, u.madhab, now); } catch { t = null; }
      } else {
        // примерные — по основному городу таймзоны телефона
        const approx = approxCoordsForTz(tz);
        if (approx) { try { t = prayerTimes(approx.lat, approx.lng, u.madhab, now); } catch { t = null; } }
      }
      if (t) {
        if (hhmm(t.fajr, tz) === nowHM && u.lastMorning !== day) { u.lastMorning = day; changed = true; send(id, MORNING_MSG); }
        if (hhmm(t.asr, tz) === nowHM && u.lastEvening !== day) { u.lastEvening = day; changed = true; send(id, EVENING_MSG); }
      } else {
        // крайний fallback для таймзон, которых нет в карте
        if (nowHM === FIXED.morning && u.lastMorning !== day) { u.lastMorning = day; changed = true; send(id, MORNING_MSG); }
        if (nowHM === FIXED.evening && u.lastEvening !== day) { u.lastEvening = day; changed = true; send(id, EVENING_MSG); }
      }
      // перед сном — всем, в их зоне
      if (nowHM === FIXED.sleep && u.lastSleep !== day) { u.lastSleep = day; changed = true; send(id, SLEEP_MSG); }
      // хифз: напоминание о повторении заученного + недельный дайджест (в зоне пользователя)
      if (u.hifz && nowHM === HIFZ_HM && u.lastHifz !== day) {
        const today = Math.floor(Date.now() / 86400000);
        const srs = u.hifz.srs || {}; let due = 0;
        for (const s in srs) { if (srs[s] && srs[s].d <= today) due++; }
        if (due > 0) {
          u.lastHifz = day; changed = true;
          send(id, `📖 Пора повторить заученное: ${due} ${pluralN(due, 'сура', 'суры', 'сур')}. Открой раздел «Прогресс» → «Повторить».`);
        } else if (weekdayInTz(now, tz) === 6) {   // суббота — дайджест
          u.lastHifz = day; changed = true;
          const pctR = Math.round(popcountB64(u.hifz.read) / 6236 * 100);
          const memC = popcountB64(u.hifz.mem);
          send(id, `📊 Твой Коран за неделю: прочитано ${pctR}%, заучено ${memC} ${pluralN(memC, 'аят', 'аята', 'аятов')}, хатмов ${u.hifz.khatm || 0}. Так держать! 🤲`);
        }
      }
    }
    if (changed) saveSubs(subs);
  });

  console.log('[bot] запущен. Напоминания включаются при запуске Mini App, если известна таймзона и пользователь не выключал их.');
}
