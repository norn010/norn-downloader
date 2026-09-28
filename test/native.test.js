import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder, parseLine, ytdlpArgs } from '../native/protocol.mjs';

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
  assert.equal(args[args.indexOf('-f') + 1], 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');
  assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
  assert.ok(args[args.indexOf('-o') + 1].startsWith(out));
  assert.ok(args.includes('--progress'), 'progress must survive the quiet mode --print implies');
});

test('the host process answers ping, and reports a missing yt-dlp instead of dying silently', async () => {
  const host = fileURLToPath(new URL('../native/norn-host.mjs', import.meta.url));
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
