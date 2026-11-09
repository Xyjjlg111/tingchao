# 给别人安装时，你（分享者）要交代的 8 件事

1. **路径别带中文**：模型加载对非 ASCII 路径偶尔翻车，`D:\tingchao\ears` 最稳。
2. **Node 版本**：必须 ≥ 20.18；低于 20 会在 ESM/内置 fetch 上出怪问题。
3. **依赖体积**：`npm install` 后约 200 MB，主要是 `sherpa-onnx-node` 的平台二进制。
4. **模型已自带**：`01_ears-service/models/` 里放好了 paraformer-large（232.2 MB）+ small（79.5 MB）+ whisper-base（56.9 MB），
   解压即可用；只有想省空间时才删掉 large，把 `EARS_PARA_DIR` 指到 small 目录。
   若对方删了模型，`/health` 会显示 `modelPresent=false`，语音会失败。
5. **只要 127.0.0.1**：这个服务**故意没有鉴权**，因为它只监听本机。别改成 0.0.0.0，
   否则等于把语音转写接口公开到局域网。
6. **别共用 3098**：一个端口只能一个实例；要并行测试就改 `EARS_PORT`。
7. **个人数据要说明**：`data/baselines.json`、`data/observations.jsonl`、`data/standards.json`
   会记录"谁在说话、说话什么节奏"。分享或交付别人机器前，**删掉这三个**（本包已删）。
8. **CASIA 权重**：`data/model.json` 是研究用途派生权重，告诉对方别商用；不想用就删。
