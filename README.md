# Media Agent — 音视频处理 Agent

运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的音视频专用
Agent，Windows / macOS 通用。它把 `ffmpeg` / `ffprobe` / `MediaInfo` 封装成 6 个安全的结构化
工具，并附带一份技能知识库，教模型正确的编码参数、工作流和命令配方。

你不需要记任何命令，直接用中文描述需求即可：Agent 会自动探测 → 选参数 → 执行 → 校验 → 汇报。

## 功能

**6 个内置工具**

| 工具 | 用途 |
|---|---|
| `av_probe` | 探测媒体文件：容器、时长、码率、编码、分辨率、帧率、HDR、声道布局、字幕语言 |
| `av_transcode` | 转码/压缩/改规格：编码、画质或码率、缩放、帧率、裁剪、硬件加速、音频参数 |
| `av_extract` | 提取音轨、字幕、抽帧序列、缩略图、波形图 |
| `av_clip` | 剪切片段（无损秒级 / 精确到帧） |
| `av_concat` | 按顺序拼接多个文件 |
| `av_batch` | 目录批量转码/换封装/提音频/缩略图/探测，可并发、可续跑 |

**技能知识库覆盖的能力**：录屏、推流直播（RTMP/RTSP/SRT）、HLS 打包、字幕烧录、音频响度
归一化、静音/转场检测、缩略图网格、GIF、HDR→SDR 色调映射、批量元数据导出、结果校验。

**跨平台**：Windows 硬件编码 `nvenc`/`qsv`/`amf`，macOS 用 `videotoolbox`；录屏 Windows 用
`gdigrab`、macOS 用 `avfoundation`。画质参数两个平台语义一致。

**内置安全特性**：无 shell 注入（全部参数为独立 argv 项）、参数执行前校验、长任务不超时、
不覆盖源文件、批量失败隔离、可续跑。

## 目录结构

```
media-agent/
├── plugin/                  插件源码（7 个工具的 Cordis 插件）
│   ├── index.js             工具定义
│   ├── lib/                 编码映射、探测、绘图、子进程、路径、schema 编译、并发池
│   └── assets/plot.py       音频绘图脚本（numpy + Pillow，无 matplotlib/scipy）
├── skills/media-agent/      技能包（模型读的知识库）
│   ├── SKILL.md
│   ├── references/          编码参数与命令配方参考
│   └── scripts/             体检脚本 + 跨平台工具链安装器
├── sample/                  测试素材（6 秒测试视频）
├── test-media-agent.mjs       argv/逻辑单元测试（57 项）
├── test-media-agent-tools.mjs 工具测试（mock Host，真跑 ffmpeg + Python，43 项）
├── test-media-agent-e2e.mjs   真实 ffmpeg 端到端测试（19 次调用）
├── LICENSE                  MIT
├── README.md                本文件
├── 功能清单.md              功能列表 + 运行依赖
├── 架构图.md                架构图（Mermaid，GitHub 可渲染）
├── 使用说明.md              功能清单与用法
└── 安装说明.md              安装步骤
```

## 安装

见 [安装说明.md](安装说明.md)。简单说：装工具链（脚本）→ 放技能 → 装插件 → 启用
`skill-filesystem` → 重启。

## 使用

见 [使用说明.md](使用说明.md)。

## 测试

```text
node test-media-agent.mjs
node test-media-agent-tools.mjs
node test-media-agent-e2e.mjs
```

三个测试都需要本机已装好工具链（默认 `~/.dsh/tools/av/bin`，或用 `DSH_AV_TOOLS` 指向别的目录）。
`test-media-agent-tools.mjs` 里的 `av_plot` 用例还需要 Python + numpy + Pillow——DSH 自带运行时已包含，
也可用 `DSH_PYTHON` 指定别的解释器。装工具链：
`node skills/media-agent/scripts/install-toolchain.mjs`。

## 许可

MIT，见 [LICENSE](LICENSE) —— Copyright (c) 2026 hanwang24。

`plugin/package.json` 保持 `private: true`：本包通过本地路径安装，不发布到 npm。
