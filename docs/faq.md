# 常见问题

**Q：`/health` 里 `engine` 是 whisper，不是我下的 paraformer？**
A：模型目录名要对（`models/paraformer-zh-small-2024-03-09` 或 `paraformer-zh-large`），
或显式设 `EARS_PARA_DIR`。缺 `model.int8.onnx` 或 `tokens.txt` 就自动退回 whisper。

**Q：第一次调用特别慢？**
A：模型懒加载，首句 1–3 秒正常；之后 40–160 ms。

**Q：判得很保守，几乎不给结论？**
A：先看 `affect.rule`：`bootstrap` 是在学基线（前 3 条不下结论），`low_margin` 是没把握。
想更爱说话就把对应情绪的门槛调低，或用 `tune-standards.mjs` 先看准确率代价。

**Q：能判"疲惫/委屈/放松"吗？**
A：代码里预留了，但没有可靠标注数据；现在的生产模型只做 angry/neutral/sad 三类。
硬加只会更不准（5 类实测 47.6%，生气掉到 33.5%）。

**Q：要 GPU 吗？**
A：不要。Intel/AMD CPU 都行，10 线程下 5 秒语音约 0.1–0.2 秒（paraformer-small）。

**Q：会把我的声音上传吗？**
A：不会。所有接口只监听 127.0.0.1，音频在内存里处理，只把数字特征写进 `data/observations.jsonl`
（没有音频、没有原文；不想要就删这个文件）。
