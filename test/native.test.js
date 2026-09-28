import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder, parseLine, ytdlpArgs, toolEnv } from '../native/protocol.mjs';

test('encodeMessage frames JSON the way Chrome native messaging expects: 4-byte little-endian length, then UTF-8', () => {
  const frame = encodeMessage({ type: 'progress', percent: 42.5, note: 'วิดีโอ' });
  const body = Buffer.from(JSON.stringify({ type: 'progress', percent: 42.5, note: 'วิดีโอ' }), 'utf8');
  assert.equal(frame.readUInt32LE(0), body.length);
  assert.deepEqual(frame.subarray(4), body);
});

test('createDecoder yields whole messages even when frames are split or packed together', () => {
  const got = [];
  const feed = createDecoder(m => got.push(m));
  const a = encodeMessage({ type: 'download', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk' });
  const b = encodeMessage({ type: 'ping' });
  const both = Buffer.concat([a, b]);
  feed(both.subarray(0, 3)); // not even the length yet
  feed(both.subarray(3, 20));
  assert.equal(got.length, 0);
  feed(both.subarray(20));
  assert.deepEqual(got, [{ type: 'download', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk' }, { type: 'ping' }]);
});

test('parseLine reads our progress and final-file lines from yt-dlp, ignores the rest', () => {
  assert.deepEqual(parseLine('NORN   42.3%'), { progress: 42.3 });
  assert.deepEqual(parseLine('NORN 100.0%'), { progress: 100 });
  assert.deepEqual(parseLine('NORN_FILE C:\\Users\\me\\Downloads\\Some Video Title [aBcDeFgHiJk].mp4'), {
    file: 'C:\\Users\\me\\Downloads\\Some Video Title [aBcDeFgHiJk].mp4',
  });
  assert.deepEqual(parseLine('ERROR: [youtube] aBcDeFgHiJk: Sign in to confirm your age'), {
    error: '[youtube] aBcDeFgHiJk: Sign in to confirm your age',
  });
  assert.equal(parseLine('[youtube] Extracting URL: https://…'), null);
  assert.equal(parseLine('NORN   N/A%'), null);
});

test('ytdlpArgs: H.264/AAC MP4, one video not a playlist, into the given folder, URL after --', () => {
  const out = path.join('C:\\Users\\me', 'Downloads');
  const args = ytdlpArgs('https://www.youtube.com/watch?v=aBcDeFgHiJk&list=PL1', out);
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/watch?v=aBcDeFgHiJk&list=PL1']);
  assert.ok(args.includes('--no-playlist'));
  // YouTube also serves VP9/AV1 inside .mp4, so ask for the codec (avc1 = H.264, mp4a = AAC), then fall back
  assert.equal(args[args.indexOf('-f') + 1], 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b');
  assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
  assert.ok(args[args.indexOf('-o') + 1].startsWith(out));
  assert.ok(args.includes('--progress'), 'progress must survive the quiet mode --print implies');
});

test('ytdlpArgs quality: height caps keep H.264 first, max takes anything, audio becomes MP3, names say which', () => {
  const out = 'C:\\Users\\me\\Downloads';
  const url = 'https://www.youtube.com/watch?v=aBcDeFgHiJk';
  const opt = (args, flag) => args[args.indexOf(flag) + 1];
  const name = args => path.basename(opt(args, '-o'));

  const p720 = ytdlpArgs(url, out, '720p');
  assert.equal(opt(p720, '-f'), 'bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=720]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b');
  assert.equal(opt(p720, '--merge-output-format'), 'mp4');
  assert.equal(name(p720), '%(title).150B [%(id)s] 720p.%(ext)s');

  const max = ytdlpArgs(url, out, 'max');
  assert.equal(opt(max, '-f'), 'bv*+ba/b');
  assert.equal(name(max), '%(title).150B [%(id)s] max.%(ext)s');

  const mp3 = ytdlpArgs(url, out, 'mp3');
  assert.equal(opt(mp3, '-f'), 'ba/b');
  assert.equal(opt(mp3, '--audio-format'), 'mp3');
  assert.ok(mp3.includes('-x') && !mp3.includes('--merge-output-format'));
  assert.equal(name(mp3), '%(title).150B [%(id)s].%(ext)s');

  // anything unexpected from the extension is treated as the default, never passed to yt-dlp
  assert.deepEqual(ytdlpArgs(url, out, '--exec calc'), ytdlpArgs(url, out));
  assert.equal(name(ytdlpArgs(url, out)), '%(title).150B [%(id)s].%(ext)s');
});

test('toolEnv runs the yt-dlp install.ps1 found, with ffmpeg and deno on PATH, even when Chrome\'s PATH is stale', () => {
  const tools = {
    ytdlp: 'C:\\W\\Packages\\yt-dlp\\yt-dlp.exe',
    ffmpeg: 'C:\\W\\Packages\\FFmpeg\\bin\\ffmpeg.exe',
    deno: 'C:\\W\\Packages\\Deno\\deno.exe',
  };
  const { command, env } = toolEnv(tools, { PATH: 'C:\\Windows', OTHER: '1' }, 'C:\\L');
  assert.equal(command, 'C:\\W\\Packages\\yt-dlp\\yt-dlp.exe');
  assert.deepEqual(env.PATH.split(path.delimiter), [
    'C:\\W\\Packages\\FFmpeg\\bin', 'C:\\W\\Packages\\Deno', 'C:\\L\\Microsoft\\WinGet\\Links', 'C:\\Windows',
  ]);
  assert.equal(env.OTHER, '1');
  // no tools.json yet: fall back to PATH lookup plus WinGet's Links folder
  const bare = toolEnv(null, { PATH: 'C:\\Windows' }, 'C:\\L');
  assert.equal(bare.command, 'yt-dlp');
  assert.deepEqual(bare.env.PATH.split(path.delimiter), ['C:\\L\\Microsoft\\WinGet\\Links', 'C:\\Windows']);
});

test('the host process answers ping, and reports a missing yt-dlp instead of dying silently', async () => {
  // a copy without tools.json, so an installed yt-dlp can't be found either
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-host-'));
  for (const f of ['norn-host.mjs', 'protocol.mjs']) fs.copyFileSync(fileURLToPath(new URL(`../native/${f}`, import.meta.url)), path.join(dir, f));
  const host = path.join(dir, 'norn-host.mjs');
  // no yt-dlp reachable: empty PATH and a LOCALAPPDATA without WinGet links
  const child = spawn(process.execPath, [host], { env: { PATH: '', LOCALAPPDATA: os.tmpdir(), SystemRoot: process.env.SystemRoot } });
  const got = [];
  child.stdout.on('data', createDecoder(m => got.push(m)));
  child.stdin.write(encodeMessage({ type: 'ping' }));
  child.stdin.write(encodeMessage({ type: 'download', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk' }));
  child.stdin.end();
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.deepEqual(got, [{ type: 'pong' }, { type: 'error', message: 'yt-dlp is not installed — run native\\install.ps1' }]);
  assert.equal(code, 0);
});
