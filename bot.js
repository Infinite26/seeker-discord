// Seeker Discord bot — joins voice calls, hears people, speaks replies.
// Requirements: DISCORD_TOKEN env var, whisper sidecar on 127.0.0.1:18771,
// Seeker's opencode brain on 127.0.0.1:4097, Kokoro TTS on 127.0.0.1:8770.
const { Client, GatewayIntentBits, Events, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource,
        EndBehaviorType, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const { pipeline } = require('stream/promises');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const prism = require('prism-media');

const TOKEN = process.env.DISCORD_TOKEN;

process.on('uncaughtException', (e) => console.error(`[uncaught] ${e && e.stack ? e.stack.split('\n')[0] : e}`));
process.on('unhandledRejection', (e) => console.error(`[unhandled] ${e && e.message ? e.message : e}`));
const WHISPER = 'http://127.0.0.1:18771';
const BRAIN = 'http://127.0.0.1:4097';
const TTS = 'http://127.0.0.1:8770';
const CHAT_URL = 'http://127.0.0.1:8317/zen/go/v1/chat/completions';
const CHAT_KEY = process.env.CHAT_KEY || '';
const CHAT_SESSION = 'seeker-discord';
const SYSTEM_PROMPT = "You are Seeker, Infinite's voice assistant, speaking in a live Discord voice call. Reply in 1-2 short spoken sentences, plain conversational text, no markdown, no lists, no emoji, no stage directions. When asked to do something, open with a brief natural acknowledgement that fits the request (like 'Will do' or 'On it'), never just 'Okay'; when asked a question, answer directly.";
const WORKDIR = '/home/infinite/.cache/seeker/workspace';
const WAKE_WORDS = ['seeker', 'seek her', 'seek a', 'seeka', 'seekah', 'sekker', 'sika', 'secret', 'speaker'];
const SILENCE_MS = 600;
const MIN_SPEECH_MS = 250;

let brainSession = null;
let player = null;
let speakingUsers = new Map(); // userId -> {buffer, lastActive}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const COMMANDS = [
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),
  new SlashCommandBuilder().setName('say').setDescription('Make Seeker say something')
    .addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true)),
].map((c) => c.toJSON());

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postWav(url, wavBuffer) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': wavBuffer.length } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(wavBuffer);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(body); } });
    }).on('error', reject);
  });
}

function pcmToWav(pcmBuffer, sampleRate = 48000, channels = 2) {
  // discord.js gives us stereo 48k PCM; whisper wants mono 16k.
  const pcm = Buffer.from(pcmBuffer);
  // Downmix stereo -> mono and 48k -> 16k by simple decimation.
  const frameSize = channels * 2; // 16-bit
  const frames = Math.floor(pcm.length / frameSize);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += pcm.readInt16LE(i * frameSize + ch * 2);
    }
    mono.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  const ratio = sampleRate / 16000;
  const outFrames = Math.floor(frames / ratio);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    out.writeInt16LE(mono.readInt16LE(Math.floor(i * ratio) * 2), i * 2);
  }
  // WAV header (16k mono 16-bit)
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + out.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(out.length, 40);
  return Buffer.concat([header, out]);
}

async function askBrain(text) {
  const body = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    max_tokens: 400,
    temperature: 0.6,
  });
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CHAT_KEY}`,
        'x-opencode-session': CHAT_SESSION,
        'User-Agent': 'SeekerDiscord/1.0',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  const parsed = JSON.parse(raw);
  if (parsed?.error) throw new Error(String(parsed.error).slice(0, 200));
  return (parsed?.choices?.[0]?.message?.content || '').trim();
}

async function speakInCall(connection, text) {
  if (!text || !text.trim()) return;
  const ttsRes = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ text, voice: 'af_bella', speed: 1.0, format: 'wav' });
    const req = http.request(`${TTS}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  if (!ttsRes.length) return;
  // Transcode WAV -> raw 48kHz stereo s16le PCM with ffmpeg and play as Raw.
  // This avoids the Ogg/ffmpeg demuxer path that was crashing the process.
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
  ff.on('error', (e) => console.error(`[ffmpeg] ${e.message}`));
  ff.stdin.on('error', () => {});
  if (!player) {
    player = createAudioPlayer();
    player.on('error', (e) => console.error(`[player] error: ${e.message}`));
  }
  const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
  resource.playStream.on('error', (e) => console.error(`[audio] ${e.message}`));
  connection.subscribe(player);
  player.play(resource);
  ff.stdin.end(ttsRes);
  console.log(`[voice] said: ${text}`);
}

function _lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

function _ratio(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - _lev(a, b) / max;
}

const WAKE_ALIASES = [
  ['seeker'], ['ok', 'seeker'], ['hey', 'seeker'], ['yo', 'seeker'],
  ['seek', 'her'], ['see', 'her'], ['seek', 'a'], ['seeka'], ['seekah'],
  ['sekker'], ['seker'], ['sika'], ['sicker'], ['speaker'], ['seekers'],
  ['shinker'], ['thinker'], ['tinker'], ['sinker'], ['shiker'], ['seeker'],
];
const WAKE_LEADING = ['secret'];

function detectWake(text) {
  const toks = (text || '').toLowerCase().replace(/'/g, '').match(/[a-z0-9]+/g) || [];
  if (!toks.length) return null;
  // multi-word aliases anywhere
  for (const seq of WAKE_ALIASES) {
    if (seq.length < 2) continue;
    for (let i = 0; i + seq.length <= toks.length; i++) {
      if (seq.every((w, j) => toks[i + j] === w)) {
        return { cmd: toks.slice(i + seq.length).join(' '), alias: seq.join(' ') };
      }
    }
  }
  const singles = new Set(WAKE_ALIASES.filter((s) => s.length === 1).flat());
  // fuzzy match to "seeker" in the first two tokens
  for (let i = 0; i < Math.min(2, toks.length); i++) {
    const t = toks[i];
    if (singles.has(t) || (t.length >= 4 && _ratio(t, 'seeker') >= 0.8) || t.startsWith('seek')) {
      return { cmd: toks.slice(i + 1).join(' '), alias: t };
    }
  }
  if (toks.length > 1 && WAKE_LEADING.includes(toks[0])) {
    return { cmd: toks.slice(1).join(' '), alias: toks[0] };
  }
  return null;
}

let convUser = null;
let convUntil = 0;
const CONV_WINDOW_MS = 12000;

async function handleTranscript(userId, username, text) {
  text = text.trim().toLowerCase();
  if (!text) return;
  console.log(`[hear] ${username}: ${text}`);
  const now = Date.now();
  const wake = detectWake(text);
  let cmd = null;
  let note = null;
  if (wake) {
    convUser = userId;
    convUntil = now + CONV_WINDOW_MS;
    cmd = wake.cmd;
    note = `matched '${wake.alias}'`;
  } else if (userId === convUser && now < convUntil) {
    cmd = text; // conversational follow-up within the window
    note = '(conversation)';
  }
  if (cmd === null) return;
  console.log(`[wake] ${note}`);
  const conn = speakingUsers.get('_connection');
  if (!conn) return;
  console.log(`[brain] asking: ${cmd || '(wake only)'}`);
  const reply = await askBrain(cmd || 'Yes?');
  await speakInCall(conn, reply);
}

const _active = new Set();

function attachListening(connection) {
  connection.receiver.speaking.on('start', (userId) => {
    if (_active.has(userId)) return;
    _active.add(userId);
    const user = client.users.cache.get(userId);
    const name = user ? user.username : userId;
    const opusStream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    // Decode Opus packets -> 48k stereo PCM, then transcribe.
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    let done = false;
    // Keep the whole utterance (including the very start, where the wake word
    // lands) — only skip truly tiny blips at the end.
    decoder.on('data', (pcm) => { chunks.push(pcm); });
    const finish = async () => {
      if (done) return;
      done = true;
      _active.delete(userId);
      const pcm = Buffer.concat(chunks);
      // 48k stereo 16-bit = 192000 bytes/sec; require >= MIN_SPEECH_MS of audio.
      if (pcm.length < (48000 * 2 * 2 * MIN_SPEECH_MS) / 1000) return;
      const wav = pcmToWav(pcm);
      try {
        const res = await postWav(`${WHISPER}/transcribe`, wav);
        if (res && res.text) await handleTranscript(userId, name, res.text);
      } catch (e) {
        console.error(`[whisper] error: ${e.message}`);
      }
    };
    decoder.on('end', finish);
    decoder.on('error', (e) => { console.error(`[receive] decode error: ${e.message}`); finish(); });
    opusStream.on('error', (e) => { console.error(`[receive] stream error: ${e.message}`); _active.delete(userId); });
    opusStream.pipe(decoder);
  });
}

const VOICE_STATE_FILE = '/home/infinite/.cache/seeker/discord_voice.json';

function saveVoiceState(guildId, channelId) {
  try { fs.writeFileSync(VOICE_STATE_FILE, JSON.stringify({ guildId, channelId })); } catch (e) {}
}
function loadVoiceState() {
  try { return JSON.parse(fs.readFileSync(VOICE_STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function clearVoiceState() {
  try { fs.unlinkSync(VOICE_STATE_FILE); } catch (e) {}
}

function joinChannel(channel) {
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  speakingUsers.set('_connection', conn);
  conn.on(VoiceConnectionStatus.Ready, () => {
    console.log(`[join] voice ready in ${channel.name}`);
    attachListening(conn);
  });
  return conn;
}

client.once(Events.ClientReady, async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
    console.log('[bot] slash commands registered');
  } catch (e) {
    console.error(`[bot] command registration failed: ${e.message}`);
  }
  // Rejoin the last voice channel so restarts are seamless.
  const saved = loadVoiceState();
  if (saved?.channelId) {
    try {
      const guild = await client.guilds.fetch(saved.guildId);
      const channel = await guild.channels.fetch(saved.channelId);
      if (channel) {
        joinChannel(channel);
        console.log(`[join] rejoined ${channel.name}`);
      }
    } catch (e) {
      console.error(`[join] rejoin failed: ${e.message}`);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  if (cmd === 'join') {
    const vc = interaction.member?.voice?.channel;
    if (!vc) return interaction.reply({ content: 'You need to be in a voice channel first.', ephemeral: true });
    await interaction.deferReply();
    joinChannel(vc);
    saveVoiceState(vc.guild.id, vc.id);
    await interaction.editReply(`Joined ${vc.name} — say "Seeker" to talk to me.`);
  } else if (cmd === 'leave') {
    const conn = speakingUsers.get('_connection');
    if (conn) conn.destroy();
    speakingUsers.clear();
    clearVoiceState();
    await interaction.reply('Left the voice channel.');
  } else if (cmd === 'say') {
    const text = interaction.options.getString('text');
    const conn = speakingUsers.get('_connection');
    if (!conn) return interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    await speakInCall(conn, text);
    await interaction.editReply('Said it.');
  }
});

client.login(TOKEN).catch((e) => {
  console.error(`[bot] login failed: ${e.message}`);
  process.exit(1);
});
