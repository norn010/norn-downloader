// Pure pieces of the yt-dlp native messaging host: Chrome's message framing, yt-dlp output parsing, and the
// yt-dlp command line. Kept free of process I/O so Node tests can import it.
import path from 'node:path';

// Chrome native messaging: each message is a 4-byte little-endian length followed by that many bytes of UTF-8 JSON.
export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Feed it stdin chunks; it calls onMessage once per complete message, however the chunks are cut.
export function createDecoder(onMessage) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (pending.length < 4 + length) break;
      onMessage(JSON.parse(pending.subarray(4, 4 + length).toString('utf8')));
      pending = pending.subarray(4 + length);
    }
  };
}

// Lines yt-dlp prints with the templates from ytdlpArgs: {progress}, {file}, {error} or null.
export function parseLine(line) {
  const progress = line.match(/^NORN\s+([\d.]+)%/);
  if (progress) return { progress: Number(progress[1]) };
  const file = line.match(/^NORN_FILE (.+)$/);
  if (file) return { file: file[1] };
  const error = line.match(/^ERROR:\s*(.+)$/);
  if (error) return { error: error[1] };
  return null;
}

// Best MP4 that plays everywhere (H.264 video + AAC audio, merged by ffmpeg), one video only, saved as
// "<title> [<id>].mp4" in outDir. --print implies --quiet, so --progress keeps the progress lines coming.
export function ytdlpArgs(url, outDir) {
  return [
    '--no-playlist',
    '--newline',
    '--progress',
    '--progress-template', 'download:NORN %(progress._percent_str)s',
    '--print', 'after_move:NORN_FILE %(filepath)s',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(outDir, '%(title).150B [%(id)s].%(ext)s'),
    '--',
    url,
  ];
}
