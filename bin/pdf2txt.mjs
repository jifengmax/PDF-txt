#!/usr/bin/env node
/**
 * pdf2txt — 把 PDF 转成纯文本的命令行工具
 *
 * 纯本地运行，不调用任何大模型或在线服务。
 * 文本抽取基于 pdf.js（通过 unpdf 内置），支持中英文、页范围、批量、目录。
 */

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { extractText, getDocumentProxy } from 'unpdf';

const VERSION = '1.0.0';

const HELP = `pdf2txt ${VERSION} — PDF 转纯文本（本地运行，不依赖大模型）

用法:
  pdf2txt <文件.pdf|目录> [更多文件...] [选项]

选项:
  -o, --out <路径>     输出文件或目录（批量时作为目录）
      --pages <范围>   只导出指定页，如 1-3,5,8-   （默认全部）
      --markers        在每页前加页码标记 "===== 第 N 页 ====="
      --stdout         输出到标准输出，不写文件
      --json           以 JSON 输出（含分页文本），打印到标准输出
      --bom            输出文件带 UTF-8 BOM（老版记事本用）
      --password <pwd> 加密 PDF 的打开密码
  -r, --recursive      目录输入时递归查找子目录
  -q, --quiet          不打印进度
  -h, --help           显示帮助
  -v, --version        显示版本

示例:
  pdf2txt 报告.pdf
  pdf2txt 报告.pdf -o 报告.txt
  pdf2txt 报告.pdf --pages 1-5 --markers
  pdf2txt ./pdfs -o ./txts -r
  pdf2txt a.pdf b.pdf --stdout
  cat a.pdf | pdf2txt - --stdout

说明:
  - 扫描版（图片型）PDF 没有文字层，导出结果为空，需要 OCR，本工具不处理。
  - 默认输出到与输入同目录的同名 .txt 文件。
`;

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = {
    out: null,
    pages: null,
    markers: false,
    stdout: false,
    json: false,
    bom: false,
    password: null,
    recursive: false,
    quiet: false,
    help: false,
    version: false,
  };
  const inputs = [];
  let i = 0;
  let endOfOptions = false;

  const needValue = (name) => {
    if (i + 1 >= argv.length) throw new UsageError(`参数 ${name} 缺少值`);
    return argv[++i];
  };

  while (i < argv.length) {
    const a = argv[i];
    if (endOfOptions || a === '-' || !a.startsWith('-')) {
      inputs.push(a);
      i++;
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      i++;
      continue;
    }
    switch (a) {
      case '-o':
      case '--out':
        opts.out = needValue(a);
        break;
      case '--pages':
        opts.pages = needValue(a);
        break;
      case '--password':
        opts.password = needValue(a);
        break;
      case '--markers':
        opts.markers = true;
        break;
      case '--stdout':
        opts.stdout = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--bom':
        opts.bom = true;
        break;
      case '-r':
      case '--recursive':
        opts.recursive = true;
        break;
      case '-q':
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      default:
        throw new UsageError(`未知选项: ${a}（用 --help 查看用法）`);
    }
    i++;
  }
  return { opts, inputs };
}

class UsageError extends Error {}
class PdfError extends Error {}

// ---------- 页范围 ----------

function parsePageRange(spec, total) {
  const pages = new Set();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    let m = part.match(/^(\d+)-(\d*)$/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : total;
      if (start < 1 || end < 1) throw new UsageError(`页范围无效: ${part}`);
      const a = Math.min(start, end);
      const b = Math.max(start, end);
      for (let p = a; p <= b; p++) if (p <= total) pages.add(p);
      continue;
    }
    m = part.match(/^-(\d+)$/);
    if (m) {
      const end = Math.min(Number(m[1]), total);
      for (let p = 1; p <= end; p++) pages.add(p);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p >= 1 && p <= total) pages.add(p);
      continue;
    }
    throw new UsageError(`页范围无效: ${part}`);
  }
  if (pages.size === 0) throw new UsageError(`页范围 ${spec} 没有选中任何页（共 ${total} 页）`);
  return [...pages].sort((a, b) => a - b);
}

// ---------- 文本整理 ----------

function cleanText(s) {
  return s
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildText(pageTexts, pageNumbers, markers) {
  return pageNumbers
    .map((n) => {
      const body = cleanText(pageTexts[n - 1] ?? '');
      return markers ? `===== 第 ${n} 页 =====\n${body}` : body;
    })
    .filter((s) => s.length > 0)
    .join('\n\n');
}

// ---------- 输入收集 ----------

async function collectInputs(inputs, recursive) {
  const files = [];
  for (const input of inputs) {
    if (input === '-') {
      files.push({ kind: 'stdin', path: '-' });
      continue;
    }
    let st;
    try {
      st = await stat(input);
    } catch {
      throw new UsageError(`找不到文件或目录: ${input}`);
    }
    if (st.isDirectory()) {
      const walk = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (recursive) await walk(full);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
            files.push({ kind: 'file', path: full });
          }
        }
      };
      await walk(input);
    } else if (st.isFile()) {
      files.push({ kind: 'file', path: input });
    }
  }
  return files;
}

// ---------- 转写 ----------

async function readPdfBytes(input) {
  if (input.kind === 'stdin') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }
  return new Uint8Array(await readFile(input.path));
}

async function pdfToText(input, opts) {
  const data = await readPdfBytes(input);
  if (data.byteLength === 0) throw new PdfError('输入为空');

  let pdf;
  try {
    pdf = await getDocumentProxy(data, {
      verbosity: 0,
      ...(opts.password ? { password: opts.password } : {}),
    });
  } catch (err) {
    throw normalizePdfError(err);
  }

  try {
    const totalPages = pdf.numPages;
    const pageNumbers = opts.pages ? parsePageRange(opts.pages, totalPages) : Array.from({ length: totalPages }, (_, i) => i + 1);

    // 只抽取选中的页，避免整本解析
    const pageTexts = new Array(totalPages).fill('');
    for (const n of pageNumbers) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pageTexts[n - 1] = content.items
        .map((item) => (typeof item.str === 'string' ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      page.cleanup();
    }

    return {
      totalPages,
      pages: pageNumbers,
      text: buildText(pageTexts, pageNumbers, opts.markers),
      texts: pageNumbers.map((n) => cleanText(pageTexts[n - 1] ?? '')),
    };
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}

function normalizePdfError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err);
  if (name === 'PasswordException' || /password/i.test(msg)) {
    return new PdfError('PDF 已加密，需要密码（可用 --password 指定）');
  }
  if (name === 'InvalidPDFException' || /Invalid PDF/i.test(msg)) {
    return new PdfError('不是有效的 PDF 文件，或文件已损坏');
  }
  return new PdfError(msg);
}

// ---------- 输出路径 ----------

function stripExt(p) {
  const ext = path.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

async function pathIsDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveOutPath(inputPath, opts, multi) {
  if (opts.out) {
    const outIsDir = (await pathIsDir(opts.out)) || /[\\/]$/.test(opts.out) || multi;
    if (outIsDir) {
      return path.join(opts.out, path.basename(stripExt(inputPath)) + '.txt');
    }
    return opts.out;
  }
  return stripExt(inputPath) + '.txt';
}

// ---------- 主流程 ----------

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`错误: ${err.message}`);
    return 2;
  }
  const { opts, inputs } = parsed;

  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.version) { process.stdout.write(`pdf2txt ${VERSION}\n`); return 0; }
  if (inputs.length === 0) {
    process.stderr.write(HELP);
    return 2;
  }

  let files;
  try {
    files = await collectInputs(inputs, opts.recursive);
  } catch (err) {
    console.error(`错误: ${err.message}`);
    return 2;
  }
  if (files.length === 0) {
    console.error('错误: 没有找到 PDF 文件');
    return 2;
  }

  if (opts.out && files.length > 1) {
    await mkdir(opts.out, { recursive: true }).catch(() => {});
  }
  if (opts.out && files.length === 1 && /[\\/]$/.test(opts.out)) {
    await mkdir(opts.out, { recursive: true }).catch(() => {});
  }

  const multi = files.length > 1;
  const jsonResults = [];
  let failed = 0;

  for (const input of files) {
    const label = input.kind === 'stdin' ? '<stdin>' : input.path;
    try {
      const res = await pdfToText(input, opts);

      if (!opts.quiet && res.text.length === 0) {
        console.error(`⚠ ${path.basename(label)}: 没有提取到文字，可能是扫描件/图片型 PDF`);
      }

      if (opts.json) {
        jsonResults.push({
          file: label,
          totalPages: res.totalPages,
          pages: res.pages,
          chars: res.text.length,
          text: res.text,
        });
      } else if (opts.stdout) {
        if (multi) process.stdout.write(`\n===== ${path.basename(label)} =====\n`);
        process.stdout.write(res.text + '\n');
      } else if (input.kind === 'stdin') {
        process.stdout.write(res.text + '\n');
      } else {
        const outPath = await resolveOutPath(input.path, opts, multi);
        await mkdir(path.dirname(outPath), { recursive: true });
        const body = (opts.bom ? '\uFEFF' : '') + res.text + '\n';
        await writeFile(outPath, body, 'utf8');
        if (!opts.quiet) {
          const pagesDesc = opts.pages ? `${res.pages.length}/${res.totalPages}` : `${res.totalPages}`;
          console.error(`✓ ${path.basename(label)} → ${outPath}  (${pagesDesc} 页, ${res.text.length} 字)`);
        }
      }
    } catch (err) {
      failed++;
      const msg = err instanceof PdfError || err instanceof UsageError ? err.message : String(err?.message || err);
      console.error(`✗ ${path.basename(label)}: ${msg}`);
    }
  }

  if (opts.json) process.stdout.write(JSON.stringify(multi ? jsonResults : jsonResults[0], null, 2) + '\n');

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`致命错误: ${err?.stack || err}`);
    process.exit(1);
  });
