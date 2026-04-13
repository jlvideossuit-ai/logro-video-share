const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const YTDLP  = process.env.YTDLP_PATH  || 'yt-dlp';
const GIFS_DIR = path.join(__dirname, 'gifs');
const TMP_DIR = path.join(__dirname, 'tmp');

[GIFS_DIR, TMP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d); });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/gifs', express.static(GIFS_DIR));

// Generate GIF from video URL
app.post('/api/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const id = uuidv4();
  const tmpVideo = path.join(TMP_DIR, `${id}.mp4`);
  const gifPath = path.join(GIFS_DIR, `${id}.gif`);

  try {
    console.log(`[1/3] Downloading video: ${url}`);
    await downloadVideo(url, tmpVideo);

    console.log(`[2/3] Generating GIF...`);
    await generateGif(tmpVideo, gifPath);
    fs.unlink(tmpVideo, () => {});

    console.log(`[3/3] Reading GIF...`);
    const gifBase64 = fs.readFileSync(gifPath).toString('base64');
    const localGifUrl = `http://localhost:${PORT}/gifs/${id}.gif`;
    console.log(`Done!`);

    res.json({ gifBase64, localGifUrl, videoUrl: url });
  } catch (err) {
    console.error(err);
    fs.unlink(tmpVideo, () => {});
    fs.unlink(gifPath, () => {});
    res.status(500).json({ error: err.message || 'Failed to generate GIF' });
  }
});

function downloadVideo(url, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--format', '18/best[ext=mp4][height<=480]/best[height<=480]/best',
      '--output', outputPath,
      '--extractor-args', 'youtube:player_client=ios,android,web',
      '--no-check-certificates',
      '--no-warnings',
      url
    ];
    const proc = execFile(YTDLP, args, { timeout: 120000 });
    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => {
      if (code === 0 || fs.existsSync(outputPath)) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function generateGif(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const palette = outputPath.replace('.gif', '_palette.png');

    const pass1Args = [
      '-ss', '0', '-t', '4', '-i', inputPath,
      '-vf', 'fps=10,scale=480:-1:flags=lanczos,palettegen=stats_mode=diff',
      '-y', palette
    ];

    execFile(FFMPEG, pass1Args, { timeout: 60000 }, (err1) => {
      if (err1) return reject(new Error('Palette generation failed'));

      const pass2Args = [
        '-ss', '0', '-t', '4', '-i', inputPath, '-i', palette,
        '-lavfi', 'fps=10,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        '-y', outputPath
      ];

      execFile(FFMPEG, pass2Args, { timeout: 60000 }, (err2) => {
        fs.unlink(palette, () => {});
        if (err2) reject(new Error('GIF generation failed'));
        else resolve();
      });
    });
  });
}

// Upload GIF – tries catbox.moe first, then transfer.sh as fallback
async function uploadToPublicHost(gifPath) {
  try {
    return await uploadToCatbox(gifPath);
  } catch (e) {
    console.warn('catbox.moe failed, trying transfer.sh:', e.message);
    return await uploadToTransferSh(gifPath);
  }
}

function uploadToCatbox(gifPath) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(gifPath);
    const fileData = fs.readFileSync(gifPath);
    const boundary = '----Boundary' + Math.random().toString(36).slice(2);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: image/gif\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const req = https.request({
      hostname: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent': 'logro-video-share/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const url = data.trim();
        if (url.startsWith('http')) resolve(url);
        else reject(new Error(`catbox: ${url}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('catbox timeout')); });
    req.write(body);
    req.end();
  });
}

function uploadToTransferSh(gifPath) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(gifPath);
    const fileData = fs.readFileSync(gifPath);

    const req = https.request({
      hostname: 'transfer.sh',
      path: `/${filename}`,
      method: 'PUT',
      headers: {
        'Content-Length': fileData.length,
        'Content-Type': 'image/gif',
        'User-Agent': 'logro-video-share/1.0',
        'Max-Downloads': '100',
        'Max-Days': '7'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const url = data.trim();
        if (url.startsWith('http')) resolve(url);
        else reject(new Error(`transfer.sh: ${url}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('transfer.sh timeout')); });
    req.write(fileData);
    req.end();
  });
}

// Cleanup old local GIFs after 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  fs.readdirSync(GIFS_DIR).forEach(f => {
    const fp = path.join(GIFS_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlink(fp, () => {});
  });
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🎬 Logro Video Share running at http://localhost:${PORT}\n`);
});
