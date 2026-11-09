# 许可与来源

## 代码

本包代码为原创脚本，随包提供，可自行修改；不提供任何担保。

## 模型文件

- **Paraformer**（sherpa-onnx 版）：Apache-2.0，来自 k2-fsa / csukuangfj 的公开发布。
- **Whisper ggml**：MIT，来自 openai/whisper + ggerganov/whisper.cpp。
- `data/model.json`（2 KB 质心模型）：用 **CASIA 中文情感语料**训练（本机生产版另用了 ESD，但 ESD 派生的权重不随包分发）。
  CASIA 原始条款为「仅供研究，请勿商用」。因此：
  - 只适合**个人学习/研究**，不要商用；
  - 不想带这份权重，直接删掉 `data/model.json`，服务会退回先验（更保守但无版权顾虑）；
  - 想换成自己的数据：见 `04_调门槛.md`。

## 参考

- CASIA 情感语料（Institute of Automation, CAS）
- ESD（Emotional Speech Dataset，NUS，需申请，研究用）
- EmotionTalk（NKU-HLT，CC BY-NC-SA 4.0）
- EmoGator（Fred W. Buhl，CC BY 4.0）
