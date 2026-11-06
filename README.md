# pdf2txt

把 PDF 转成纯文本的命令行工具。**纯本地运行，不调用任何大模型、不上传文件、不依赖网络。**

A local PDF-to-text CLI. No LLM, no cloud, no data leaves your machine.

底层文本抽取使用 [pdf.js](https://github.com/mozilla/pdf.js)（通过 [unpdf](https://github.com/unjs/unpdf)），只做规则解析，不做 AI 推理。

## 环境要求

- Node.js **24 及以上**
- Windows / macOS / Linux

## 安装

```bash
npm install
npm link        # 之后可直接用 pdf2txt 命令
```

不想 link 的话，直接运行：

```bash
node bin/pdf2txt.mjs --help
```

Windows 下也可以双击/调用 `pdf2txt.cmd`。

## 用法

```text
pdf2txt <文件.pdf|目录> [更多文件...] [选项]
```

| 选项 | 说明 |
| --- | --- |
| `-o, --out <路径>` | 输出文件；批量时作为输出目录 |
| `--pages <范围>` | 只导出指定页，如 `1-3,5,8-` |
| `--markers` | 每页前加 `===== 第 N 页 =====` |
| `--stdout` | 打印到标准输出，不写文件 |
| `--json` | 输出 JSON（含分页文本） |
| `--bom` | 输出文件带 UTF-8 BOM |
| `--password <pwd>` | 加密 PDF 的打开密码 |
| `-r, --recursive` | 目录输入时递归子目录 |
| `-q, --quiet` | 不打印进度 |
| `-h, --help` | 帮助 |
| `-v, --version` | 版本 |

## 示例

```bash
# 单文件：生成同目录同名 .txt
pdf2txt 报告.pdf

# 指定输出
pdf2txt 报告.pdf -o 报告.txt

# 只要前 5 页，带页码
pdf2txt 报告.pdf --pages 1-5 --markers

# 整个目录批量转
pdf2txt ./pdfs -o ./txts -r

# 多个文件拼到标准输出
pdf2txt a.pdf b.pdf --stdout

# 管道
cat a.pdf | pdf2txt - --stdout
```

## 说明与限制

- **扫描版 PDF 转不出文字**：图片型 PDF 没有文字层，输出为空，需要 OCR；本工具不处理。
- 双栏、复杂表格的阅读顺序取决于 PDF 内部结构，可能不完美；`--markers` 便于核对分页。
- 输出统一 UTF-8；给老软件用可加 `--bom`。
- 加密 PDF 会提示需要密码，可用 `--password`。

## License

MIT。内置依赖：unpdf（MIT）、pdf.js（Apache-2.0）。
