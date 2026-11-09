# 听潮 / Tingchao

给 AI 助手加一对"耳朵"：本地中文语音转写 + 按说话人自己的基线归一化的情绪倾向，压缩成一行文本注入上下文。

An on-premise speech-to-text + voice-affect service for LLM agents. It transcribes
Chinese voice messages locally and emits a single compact line:

```
[语音 5秒｜示例用户(1000000000)｜听潮.90/1.34/1.12x → 像低落]
```

这行的定位是**证据，不是判决**：数字是相对这个人自己平时的基线，结论只给倾向、不带置信度数字，也允许被说话内容推翻。

## 结构

| 目录 | 内容 |
| --- | --- |
| `service/` | Node 服务：Paraformer（默认）/ whisper 回退 + 11 项韵律特征 + 按人基线的质心判定 |
| `dsh-panel/` | 可选：DeepSeek Harness 客户端插件，在设置页管理「通用标准 + 每人标准 + 群标准」 |
| `docs/` | 安装、使用、面板、门槛、常见问题、许可、数据集说明 |

## 快速开始

```bash
cd service
npm install
EARS_PORT=3098 node server.mjs
curl http://127.0.0.1:3098/health
```

模型不随仓库分发（体积与许可原因）。没有 ASR 模型时 `/health` 会如实报
`modelPresent:false`；没有情绪模型时服务以 `prior` 模式运行，只输出声学读数、
不下结论——这是刻意的保守设计。

模型下载与训练见 [docs/install.md](docs/install.md)。

## 它做什么 / 不做什么

- 做：把 QQ / 微信收到的语音转成文字（本地，不外发）；给出「语速 / 音高起伏 / 停顿」这类相对读数；在足够有把握时补一句 `→ 像低落` 或 `→ 像生气?`。
- 不做：不判断对方"真实感受"，不做人格分析，不上传音频，不保存原始录音（只留数值特征）。

## 为什么不上传模型权重

- Paraformer / whisper 权重各有上游许可，请按上游许可自行下载；
- 本项目的情绪质心是用 CASIA、ESD 等**研究用途**语料训练的实验产物，不能再分发。
  仓库里只带训练脚本，你可以用自己有权使用的语料重建（见 `docs/datasets.md`）。

## 许可

代码 MIT。模型与语料不随仓库分发，见 [docs/licenses.md](docs/licenses.md)。
