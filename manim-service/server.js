// Minimal Manim render service (Node + Express)
// Requirements on the host:
// - Python 3 and Manim Community installed and available on PATH (e.g. `pip install manim`)
// - The `manim` CLI should be callable, or set MANIM_BIN to its full path

import express from 'express';
import cors from 'cors';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Ensure TeX binaries (latex, dvisvgm, tlmgr, etc.) are visible to spawned processes
const TEXBIN = process.env.TEXBIN || '/Library/TeX/texbin';
if (process.env.PATH && !process.env.PATH.includes(TEXBIN)) {
  process.env.PATH = `${TEXBIN}:${process.env.PATH}`;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8787;
const MANIM_BIN = process.env.MANIM_BIN || null; // if null, uses python -m manim
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const ASY_BIN = process.env.ASY_BIN || 'asy';
const XVFB_BIN = process.env.XVFB_BIN || 'xvfb-run';

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/render', async (req, res) => {
  try {
    const { code, scene = 'GeneratedScene', format = 'mp4', quality = 'ql' } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing `code` (string)' });
    }
    // If the scene uses LaTeX (Tex/MathTex), proactively check for TeX toolchain
    // so we can return a clear, actionable error rather than a generic spawn failure.
    const usesLatex = /(\bMathTex\s*\(|\bTex\s*\()/.test(code);
    if (usesLatex) {
      const [hasLatex, hasDvisvgm] = await Promise.all([
        cmdExists('latex', ['--version']),
        cmdExists('dvisvgm', ['--version'])
      ]);
      if (!hasLatex || !hasDvisvgm) {
        return res.status(422).json({
          error: 'LaTeX toolchain not found',
          details: 'Your Manim code uses Tex/MathTex, which requires LaTeX (latex) and dvisvgm.',
          missing: {
            latex: !!hasLatex,
            dvisvgm: !!hasDvisvgm,
          },
          hints: [
            'macOS: brew install --cask basictex && echo "export PATH=/Library/TeX/texbin:$PATH" >> ~/.zshrc',
            'then: sudo tlmgr update --self && sudo tlmgr install dvisvgm cm-super type1cm amsfonts amsmath xcolor geometry standalone preview latexmk',
            'Alternatively, avoid Tex/MathTex and use Text/MarkupText for non-LaTeX labels.'
          ]
        });
      }
    }
    const qFlag = String(quality).toLowerCase(); // ql | qm | qh | qp | qk
    if (!/^q[lmhpk]$/.test(qFlag)) {
      return res.status(400).json({ error: 'Invalid `quality` (use ql, qm, qh, qp, qk)' });
    }
    const fmt = String(format).toLowerCase();
    if (!['mp4', 'gif'].includes(fmt)) {
      return res.status(400).json({ error: 'Invalid `format` (mp4|gif)' });
    }

    // Work directory
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'manim-'));
    const pyFile = path.join(work, 'scene.py');
    await fs.writeFile(pyFile, code, 'utf8');

    const outBase = 'out';
    const args = [
      `-${qFlag}`,
      '--format', fmt,
      '-o', outBase,
      pyFile,
      scene,
    ];

    // Prefer explicit MANIM_BIN; else prefer local venv bin; else python -m manim
    let preferredBin = MANIM_BIN;
    if (!preferredBin) {
      const venvBin = path.join(REPO_ROOT, '.manim-venv', 'bin', 'manim');
      try { await fs.stat(venvBin); preferredBin = venvBin; } catch {}
    }
    const cmdCfg = preferredBin
      ? { cmd: preferredBin, argv: args }
      : { cmd: PYTHON_BIN, argv: ['-m', 'manim', ...args] };

    const child = spawn(cmdCfg.cmd, cmdCfg.argv, { cwd: work });
    let stdout = '';
    let stderr = '';
    let responded = false;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', async (err) => {
      console.error('spawn error', err);
      if (!responded) {
        responded = true;
        res.status(500).json({ error: 'Failed to run manim', details: String(err) });
      }
      cleanup(work);
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        console.error('manim failed', { code, stdout, stderr });
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Manim render failed', code, stdout, stderr });
        }
        cleanup(work);
        return;
      }
      try {
        const wanted = fmt === 'gif' ? 'out.gif' : 'out.mp4';
        const found = await findFileRecursive(work, wanted);
        if (!found) {
          console.error('output not found', { work, stdout, stderr });
          if (!responded) {
            responded = true;
            res.status(500).json({ error: 'Output not found', stdout, stderr });
          }
          cleanup(work);
          return;
        }
        const data = await fs.readFile(found);
        if (!responded) {
          responded = true;
          res.setHeader('Content-Type', fmt === 'gif' ? 'image/gif' : 'video/mp4');
          res.setHeader('Content-Length', data.length);
          res.send(data);
        }
      } catch (e) {
        console.error('send error', e);
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Failed to send file', details: String(e) });
        }
      } finally {
        cleanup(work);
      }
    });
  } catch (e) {
    console.error('render route error', e);
    res.status(500).json({ error: 'Server error', details: String(e) });
  }
});

// Asymptote render endpoint
// Body: { code: string, format: 'png'|'svg' }
app.post('/asy', async (req, res) => {
  try {
    const { code, format = 'png' } = req.body || {};
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Missing `code` (string)' });

    // Check asymptote availability
    const hasAsy = await cmdExists(ASY_BIN, ['--version']);
    if (!hasAsy) {
      return res.status(422).json({
        error: 'Asymptote not found',
        details: 'Install the `asymptote` binary in the environment.',
        hints: [
          'Debian/Ubuntu: apt-get update && apt-get install -y asymptote',
          'macOS: brew install asymptote',
        ]
      });
    }

    const fmt = String(format).toLowerCase();
    if (!['png', 'svg'].includes(fmt)) return res.status(400).json({ error: 'Invalid `format` (png|svg)' });

    // Work directory
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'asy-'));
    const asyFile = path.join(work, 'main.asy');
    await fs.writeFile(asyFile, code, 'utf8');

    const outStem = 'out';
    const ext = fmt === 'svg' ? 'svg' : 'png';
    const args = ['-f', fmt, '-tex', 'pdflatex', '-o', outStem, asyFile];

    // Prefer headless rendering via xvfb if available (required for 3D/freeglut)
    const useXvfb = await cmdExists(XVFB_BIN, ['--help']).catch(() => false);
    const cmd = useXvfb ? XVFB_BIN : ASY_BIN;
    const argv = useXvfb ? ['-a', '-s', '-screen 0 1280x1024x24 -ac +extension GLX', ASY_BIN, ...args] : args;
    const child = spawn(cmd, argv, { cwd: work });
    let stdout = '';
    let stderr = '';
    let responded = false;
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', async (err) => {
      console.error('asy spawn error', err);
      if (!responded) {
        responded = true;
        res.status(500).json({ error: 'Failed to run asymptote', details: String(err) });
      }
      cleanup(work);
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        console.error('asymptote failed', { code, stdout, stderr });
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Asymptote render failed', code, stdout, stderr });
        }
        cleanup(work);
        return;
      }
      try {
        const found = await findAsyOutput(work, ext, outStem);
        if (!found) {
          console.error('asymptote output not found', { work, stdout, stderr });
          if (!responded) {
            responded = true;
            res.status(500).json({ error: 'Output not found', stdout, stderr });
          }
          cleanup(work);
          return;
        }
        const data = await fs.readFile(found);
        if (!responded) {
          responded = true;
          res.setHeader('Content-Type', fmt === 'svg' ? 'image/svg+xml' : 'image/png');
          res.setHeader('Content-Length', data.length);
          res.send(data);
        }
      } catch (e) {
        console.error('asy send error', e);
        if (!responded) {
          responded = true;
          res.status(500).json({ error: 'Failed to send file', details: String(e) });
        }
      } finally {
        cleanup(work);
      }
    });
  } catch (e) {
    console.error('asy route error', e);
    res.status(500).json({ error: 'Server error', details: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Manim service listening on http://localhost:${PORT}`);
});

async function findFileRecursive(dir, fileName) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name === fileName) return p;
    }
  }
  return null;
}

function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// Simple binary existence check
function cmdExists(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0 || code === 1));
    } catch (_) {
      resolve(false);
    }
  });
}

// Find typical Asymptote outputs: out.svg, out-0.svg, out-1.svg, or any .ext in the work tree
async function findAsyOutput(dir, ext, stem = 'out') {
  const preferred = new Set([
    `${stem}.${ext}`,
    `${stem}-0.${ext}`,
    `${stem}-1.${ext}`
  ]);
  const stack = [dir];
  const candidates = [];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) {
        if (preferred.has(ent.name)) return p;
        if (ent.name.endsWith('.' + ext)) candidates.push(p);
      }
    }
  }
  return candidates[0] || null;
}
