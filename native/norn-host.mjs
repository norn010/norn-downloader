// Native messaging host: Chrome starts it (through norn-host.bat) when the extension asks for a yt-dlp download.
// In: {type:'download', url} or {type:'ping'}. Out: {type:'progress', percent}, {type:'done', file}, {type:'error', message},
// {type:'pong'}. Nothing but framed messages may ever go to stdout.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { encodeMessage, createDecoder, parseLine, ytdlpArgs } from './protocol.mjs';

const send = message => process.stdout.write(encodeMessage(message));

// winget puts yt-dlp, ffmpeg and deno in this folder; Chrome may have started before it joined PATH
const links = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links');
const env = { ...process.env, PATH: `${links}${path.delimiter}${process.env.PATH ?? ''}` };

let running = 0;
let inputClosed = false;
const maybeExit = () => inputClosed && running === 0 && process.exit(0);

function download(url) {
  running++;
  let file = null;
  let error = '';
  const child = spawn('yt-dlp', ytdlpArgs(url, path.join(os.homedir(), 'Downloads')), { env, windowsHide: true });
  const readLines = stream => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', text => {
      const lines = (rest + text).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        const got = parseLine(line.trim());
        if (got?.progress !== undefined) send({ type: 'progress', percent: got.progress });
        if (got?.file) file = got.file;
        if (got?.error) error = got.error;
      }
    });
  };
  readLines(child.stdout);
  readLines(child.stderr);
  child.on('error', e => {
    error = e.code === 'ENOENT' ? 'yt-dlp is not installed — run native\\install.ps1' : e.message;
  });
  child.on('close', code => {
    running--;
    send(code === 0 ? { type: 'done', file } : { type: 'error', message: error || `yt-dlp stopped (exit code ${code})` });
    maybeExit();
  });
}

process.stdin.on(
  'data',
  createDecoder(message => {
    if (message.type === 'ping') send({ type: 'pong' });
    else if (message.type === 'download' && /^https?:\/\//.test(message.url)) download(message.url);
    else send({ type: 'error', message: 'Unknown request' });
  }),
);
process.stdin.on('end', () => {
  inputClosed = true; // the extension let go; finish any download first
  maybeExit();
});
