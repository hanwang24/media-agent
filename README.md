# Media Agent — 音视频处理 Agent

运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的音视频专用
Agent，Windows / macOS 通用。它把 `ffmpeg` / `ffprobe` / `MediaInfo` 封装成 7 个安全的结构化
工具，并附带一份技能知识库，教模型正确的编码参数、工作流和命令配方。

你不需要记任何命令，直接用中文描述需求即可：Agent 会自动探测 → 选参数 → 执行 → 校验 → 汇报。

## 亮点

- **零 shell 注入**：所有参数都作为**独立 argv 项**传给 ffmpeg，从不拼命令行字符串——路径里含空格、
  `&`、`$` 也不会改变命令；参数在执行前经过 schema 校验，非法值直接报错而不是传给 ffmpeg。
- **支持裸流（elementary stream）**：把 ffmpeg 的 `-f` 暴露为 `inputFormat`/`outputFormat`，所以
  **没有容器的裸 `.h264` / `.h265` / `.aac` 也能先探测再封装**（实测：裸 H.264 探测出
  1280x720，再以 `copy` 无损封装成 mp4）。
- **对标 Audition 的音频可视化，且零额外依赖**：波形图（逐像素峰值包络、L/R 分离）、频谱图
  （STFT + 对数频率轴 + dB 色标）、频响图（FFT 幅度曲线）全部用 **numpy + Pillow 手绘**——
  不需要 matplotlib、scipy，更不需要 MATLAB。
- **长任务永不超时**：媒体工具**故意不声明** `timeoutMs`（DSH 的超时策略只掐声明了预算的工具），
  所以再长的转码也不会被中途切断；同时仍通过 `exec.signal` 支持取消。
- **批量可续跑 + 失败隔离**：`av_batch` 跳过已存在的输出（大任务随时中断再继续）、并发有界、
  单个文件失败不影响其他文件，并逐个文件汇报结果。
- **相对路径按会话工作区解析**：以会话的工作目录为基准（与官方 shell 工具一致），
  报错信息直接给出解析后的绝对路径，避免"路径找不到"的来回试错。
- **跨平台**：Windows 用 `nvenc`/`qsv`/`amf`、macOS 用 `videotoolbox`；`quality` 参数在两个平台
  **语义完全一致**（macOS 上自动换算成 videotoolbox 的反向 `-q:v` 刻度）。录屏 Windows 用
  `gdigrab`、macOS 用 `avfoundation`。
- **无重依赖**：插件是纯 Node 内置模块（零 npm 依赖），绘图用 DSH 自带的 Python；
  不需要 GPU，也不改系统 PATH。
- **测试是真的**：119 项检查（57 单元 + 43 工具 + 19 端到端），其中工具测试**真的执行
  ffmpeg 和 Python**、并校验生成的 PNG 而非只比对字符串。

### 开发中靠测试揪出并修掉的真实缺陷

| 问题 | 现象 | 修复 |
|---|---|---|
| `-avoid_negative_ts make_zero` | 请求 3 秒的 `copy` 剪切实际产出 4 秒文件 | 移除该参数 |
| concat 列表写相对路径 | 解复用器按**列表文件所在目录**解析，拼成 `dir/dir/file` 而失败 | 写入绝对路径 |
| 返回值含 `undefined` | 真实 registry 拒绝"非无损失 JSON"，裸流 remux 与抽帧直接报错 | 统一裁剪为无损失 JSON |

## 功能

**7 个内置工具**

| 工具 | 用途 |
|---|---|
| `av_probe` | 探测媒体文件：容器、时长、码率、编码、分辨率、帧率、HDR、声道布局、字幕语言；`inputFormat` 可探测裸流 |
| `av_transcode` | 转码/压缩/改规格：编码、画质或码率、缩放、帧率、裁剪、硬件加速、音频参数；`inputFormat`/`outputFormat` 支持裸流 remux |
| `av_extract` | 提取音轨、字幕、抽帧序列、缩略图、波形图 |
| `av_clip` | 剪切片段（无损秒级 / 精确到帧） |
| `av_concat` | 按顺序拼接多个文件 |
| `av_plot` | 音频可视化：波形图、频谱图、频响图，输出 PNG |
| `av_batch` | 目录批量：转码/换封装/提音频/缩略图/**出图**/探测，可并发、可续跑 |

**技能知识库覆盖的能力**：录屏、推流直播（RTMP/RTSP/SRT）、HLS 打包、字幕烧录、音频响度
归一化、静音/转场检测、缩略图网格、GIF、HDR→SDR 色调映射、批量元数据导出、结果校验。
（安全与跨平台特性见上方「亮点」。）

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

## 已知限制

- **macOS 分支未在真机验证**：`videotoolbox`、`avfoundation` 相关代码按 ffmpeg 标准行为实现并有
  单元测试覆盖，但开发机是 Windows，没有在 Mac 上实跑过。
- **录屏与推流不是工具**：它们是无限运行的进程，包成同步工具会卡住会话，因此写成命令配方，
  由后台任务执行（见 `skills/media-agent/references/recipes.md`）。
- **裸流探测的帧率不一定准**：无容器码流缺少时序信息，ffprobe 只能给出推测值；封装进容器后
  帧率才可靠。
- **`copy` 剪切起点只能落在关键帧上**：长度精确，起点会略早于请求时间；要精确到帧请用
  `mode: "reencode"`。
- **拼接要求各文件编码/分辨率/时间基/流数量一致**，否则需先统一转码。
- **Dolby Vision 支持不完整**；HDR→SDR 需要显式色调映射，否则画面发灰。
- **软件 AV1 很慢**：Windows essentials 构建只有 `libaom-av1`（无 `libsvtav1`），用前建议先跑
  `av-doctor` 确认当前构建的能力。

## 许可

MIT，见 [LICENSE](LICENSE) —— Copyright (c) 2026 hanwang24。

`plugin/package.json` 保持 `private: true`：本包通过本地路径安装，不发布到 npm。
