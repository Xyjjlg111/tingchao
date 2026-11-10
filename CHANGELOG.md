# Changelog

## 0.1.0 — 2026-11-09

- 首个公开版本：本地中文转写（Paraformer / whisper 回退）+ 说话人归一化的语气提示
- 控制面板：通用标准 / 个人卡片 / 群聊标准，门槛可独立调整
- 不附带模型权重与语料（见 `docs/licenses.md` 与 `docs/datasets.md`）

## 0.1.1 — 2026-11-10

- 新增：语音留存（`saveAudio`）与 `baseline-exclude.json` 基线去污染说明
- 新增：`POST /baseline/set` 手动写死基线（剔除被污染时段后重算）
- 新增：`train-my-model.mjs`（15–45 句自训脚本，之前只在本地）
- 修正：`/baseline/set` 读取 `readJsonSafe` 的 `value` 字段
- 文档：README 增补 0.9.2 节（留存/排除区间/疲惫样本实测 AUC 0.712，不足以加「疲惫」）
