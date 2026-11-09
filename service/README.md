# dsh-ears-svc — 小鱼儿的耳朵（本地语音转写 + 语气判断）

独立 Node 服务，127.0.0.1:3098。不碰 DSH profile，不依赖 Python，不联网。

## 两个能力

1. **转写**：`@fugood/whisper.node` + `ggml-base-q5_1.bin`（59.7MB，中文，10 线程约 3.5–4 秒/5 秒音频）
2. **语气**：纯信号处理（基频/能量/语速/停顿/句尾/过零率），0 token，可解释

## 为什么用「相对判断」

同一个人「累」的时候，别人可能觉得正好；不同人音高、语速差异极大。所以判语气不看绝对值，而是看**和这个人自己平时比**：

```
rate_rel      = 本次语速 / 这个人平时的语速
pitchVar_rel  = 本次音高起伏 / 平时的起伏
pause_rel     = 本次停顿比例 / 平时的停顿
energyVar_rel = 音量起伏比
zcr_rel       = 音色亮度比（摩擦/挤压感）
tailDrop      = 句尾下沉（半音）
```

基线只存**数字**（每个人最近 60 条的六项中位数），不存音频、不存原文、不上传。

- 冷启动：前 3 条当基线样本，返回 `neutral`（`rule=bootstrap`）
- 样本 <10 条时，基线和人群先验按 `n/10` 混合，避免头几条正好是累的就把基线带偏
- 之后：证据弱的普通语音继续修正基线；强情绪样本不污染基线

## 判成什么

| 标签 | 中文 | 需要同时满足的迹象 |
|---|---|---|
| tired | 疲惫 | 语速 ≤0.88× + （停顿 ≥1.22× / 音量平 / 声音轻） |
| sad | 低落 | 句尾下沉 ≥1.2 半音 + 语速 ≤0.96× + 起伏 ≤0.95× |
| happy | 高兴 | 语速 ≥1.10× + 起伏 ≥1.12× |
| excited | 兴奋 | 语速 ≥1.25× + 起伏 ≥1.40× |
| relaxed | 放松 | 语速 0.86–1.14× + 起伏 ≤0.86× + 停顿不夸张 + 句尾不下沉 |
| angry | 烦躁 | 音量起伏 ≥1.22× + 起伏 ≥1.18× + 音色更亮 ≥1.08× |
| neutral | 平常 | 证据不够（**默认结果**，桥接不注入任何字） |

置信度 <0.45 或第一名与第二名差距 <0.05 → 一律 `neutral`。宁可不说，也不乱贴。

## HTTP

```
GET  /health                        → 版本、模型、基线人数、校准模型
POST /analyze?speaker=<QQ>  (wav)   → { asr, affect }
POST /affect?speaker=<QQ>   (wav)   → 只要语气
GET  /baselines                     → 已学到的人声基线（数字）
POST /baseline/reset?speaker=<QQ>   → 清掉某人的基线
```

`affect` 返回里带 `label / labelCN / confidence / rule / reason / features / relative / scores`。

## 校准（可选，想更准再做）

`data/observations.jsonl` 会自动记录每次分析的**特征**（无音频、无原文）。

```bash
node label.mjs --list 12                 # 看最近的，带序号
node label.mjs --index 3 --label tired   # 按你真实感受标注
node calibrate.mjs                       # 训练 + 留一法评估 → data/affect-model.json
```

有校准模型后自动切到「最近质心」打分；准确率 <65% 时脚本会拒绝写模型并提示补样本。
建议每类 8–15 条真实语音，至少覆盖 平常/疲惫/高兴/低落。

## 测试

```bash
node test-affect.mjs        # 15 项：规则、兜底、基线、相对量
node test-integration.mjs   # 假网关 + 真 whisper 的端到端
```

## 与桥接的分工

`<drive>/qq-bridge\src\voice-ears.js` 负责：取语音（`get_record`）→ 调本服务 → 拼成
`[语音 5秒｜示例用户｜语气:疲惫 0.62（语速慢+停顿多）] 正文`。

- 失败不再静默变成 `[语音]`，而是 `[语音 · 未能转写]`
- 连续失败 3 次熔断 60 秒；`EARS_OFF=1` 可硬关；`enabled=false` 时行为与改装前完全一致

## token

| 情况 | 增量 |
|---|---|
| neutral（大多数） | **0**（`renderHeart` 返回空串，桥接不写语气） |
| 带语气，5 秒短语音 | ≈ 25–30 token（前缀）+ 正文 |
| 转写/韵律/缓存/观察日志 | 0 token（不经过模型） |

## 0.3.0 —— 区间原型（记忆点）情绪库

判定不再只靠规则，而是「拿这段语音去比对每个记忆点（原型）的区间」：

- 每个记忆点 = 一种情绪的一个典型样子（比如「火」有「高声吼」和「压低冷」两个记忆点），每个记忆点对 7 个因素各有一条**区间**（不是单点），并带一个**权重**（区间越窄、越可靠，权重越高）。
- 因素（都是「相对这个人自己平时」的倍数）：rate 语速、pitchVar 音高起伏、pause 停顿占比、energyVar 音量起伏、energyDb 整体音量(dB)、zcr 音色亮度、tailDrop 句尾下沉。
- 判定：逐因素看落没落在区间里 → 加权投票 → 得分；再按「得分 → 离区间中点距离 → 专一度」排序。
  - 最高分 <0.55 → 平常（不注入）
  - 命中「平常」记忆点 → 平常
  - ≥0.72 且领先 ≥0.12 → 单标签；否则双标签（「委屈/低落」）
- **强度** 0–100 由偏离程度算，分段为 轻 0–30 / 有点 25–55 / 明显 50–80 / 很强 72–100（区间故意重叠，因为「有点生气」和「明显生气」本来就分不清）。
- **守卫（GUARDS）**：有的情绪必须先有发声上的证据才算，比如「火」必须音色更亮且（音量起伏↑或更响或更快），否则一句「语速稍慢的平常话」会被误判成「压着的火」——这是真实语音里最常见的假阳性。

### 先验库 vs 语料库

- 没有 `data/prototypes.json` 时用**教科书先验**（9 个记忆点），偏保守：只有「单标签且置信度 ≥0.80」才敢下结论，否则当平常。
- 有语料后用 `ingest-corpus.mjs` + `build-prototypes.mjs` 生成 `data/prototypes.json`，阈值放宽到 0.55。**准确率来自语料，不来自先验。**

### 语料目录约定

    corpus/<情绪>/<说话人>/*.wav     或     corpus/<说话人>/<情绪>/*.wav

情绪名用英文标签：happy / excited / tired / sad / angry / relaxed / neutral。
同名 `.txt` 存在时按「字数/时长」算真实语速（更准）；没有就用代理值并标记 `rateMeasured:false`。

    node ingest-corpus.mjs --root ./corpus          # → data/samples.jsonl
    node build-prototypes.mjs --min 3 --kmax 4      # → data/prototypes.json
    node build-prototypes.mjs --loo                 # 留一人交叉验证（≥3 人才跑）

### 省电联动

省电模式进入时，`eco-mode.ps1` 会关掉 3098（语音系统整体停），退出（开盖/插电）时自动拉起；`boot-check` 与 `watch-her` 在省电期间不会把它救活。判定依据是 `<repo>/logs\eco-state.json` 的 `eco` 字段。

## 0.4.0 —— 中文引擎换成 Paraformer（2026-11-08）

**为什么换**：whisper base 处理 5 秒语音要 4.0–4.2 秒；small 更准但要 10–14 秒。
换成 sherpa-onnx 的中文 Paraformer（非自回归结构，一次前向出整句）后，同样的语音 **50–160ms**。

**装了什么**
- `models/sherpa-onnx-paraformer-zh-small-2024-03-09/`（78MB `model.int8.onnx` + `tokens.txt`）
- 依赖 `sherpa-onnx-node@2.0.1`（含 win-x64 原生二进制）

**行为**
- 默认 `EARS_ENGINE=auto`：有 Paraformer 就用它，失败自动回退 whisper（原逻辑一行未改）
- `EARS_ENGINE=whisper` 可一键切回
- 转写**无标点**（Paraformer small 的特性）；标点可以后续接 sherpa 的 punctuation 模型
- 单条上限 `EARS_MAX_SECONDS=60`（Paraformer 处理 30 秒也只要 0.6 秒）

**实测（2026-11-08 早）**
| 样本 | 耗时 | 文本 |
|---|---|---|
| zh-tired | 62ms | 今天加班到九点别等我了我有点累 |
| zh-sad | 49ms | 随便吧反正你也不在乎我怎么说 |
| n1 | 68ms | 我待惠儿要下楼拿个快递顺便看看有没有新的快递柜 |
| slow_low | 114ms | 今天出了一天代码累的不行我现在只想躺一会儿 |

## 0.5.0 —— 判定换成「按人归一化 + 最近质心」（2026-11-08）

区间原型适合解释，不适合判定。CASIA 1,000 条上实测（留一人交叉验证）：

| 方法 | 特征 | LOO |
|---|---|---|
| 区间原型（旧） | 7 维 | 27.8% |
| 最近质心 | 全部 10 维 | 43.7% |
| 最近质心（3 类） | 全部 10 维 | 65.5% |
| **最近质心（3 类）** | **rate / energyDb / zcr** | **71.8%** |

- 三分类：生气 81.5% / 平常 69% / 低落 65.5%（训练 600 条，留一说话人验证）。
- 新增声学特征（`lib/prosody.mjs`）：`pitchSlope` 音高走向、`tailTrend` 句尾 250ms 走向、`peakRate` 能量峰≈音节节奏、`hnr` 谐噪比（用自相关峰估）。
- 训练：`build-model.mjs --labels angry,neutral,sad --keys rate,energyDb,zcr --loo` → `data/model.json`。
- 选特征：`tune-model.mjs`（贪心，一次加一个特征，只看 LOO）。
- 判定顺序：质心（够近且领先 ≥0.18）→ 区间原型 → 规则版 → 平常。太远（> 该类 90 分位半径）就弃权，交给原型。
- 基线只从「偏平常」的语音里学，避免把一条很累的语音学成"平时的样子"。

已知短板（不藏）：`sad` 在留出说话人上仍偏弱（~65%）；`excited` 常被归到 `angry`（两者都高能量高亮），因为模型里没有 excited 类；短句（<1.2 秒）特征噪声大。
## 0.6.0 —— 非语言发声（笑 / 叹气 / 哭腔）

来源：[EmoGator](https://github.com/fredbuhl/EmoGator)（CC BY 4.0），32,130 条发声、357 个说话人。
本地副本：`<corpus>/EmoGator\extract\EmoGator-main\data\mp3`（已全量下载）。

做法：
1. `burst-ingest.mjs` 解码 mp3 → 16k 单声道 → 同一套韵律特征 → `data/burst-samples.jsonl`
   （31,488 条可用，失败 642 条多为解码/过短；happy 12,652 / sad 8,331 / neutral 7,332 / angry 3,173）
2. `tune-burst.mjs` 贪心选特征（去掉 rate / pause —— 发声没有说话的字和停顿结构）
3. `build-burst-model.mjs --baseline global --loo` → `data/burst-model.json`
   - 只学两极：happy（笑/雀跃） / sad（叹气/哭腔）
   - 特征：pitchRange、zcr、energyVar、energyDb
   - 留一人交叉验证：**61.7%**（happy 0.636 / sad 0.588；机会水平 50%）
4. `evaluate-burst.mjs` 扫阈值：margin≥0.10 时覆盖 30.5%、精度 0.698（happy 0.745 / sad 0.555）

结论（重要）：**默认不注入**。
- 「像在叹气」在任何阈值上精度都没超过 0.6，注入会把她带偏；
- 「像在笑」加形状约束后约 0.775，但换说话人实测仍有约 1/3 误报；
- 因此代码保留完整链路，但 `EARS_BURST_HINT=1` 才启用注入；默认只作为 `/analyze` 的
  `affect.domain=burst` 诊断信息返回，不进入她的上下文。

分工：说话（有字）走 CASIA 质心模型；纯发声走这里的 burst 模型；两者都不确定时保持 `[语音]`。
## 0.7.0 —— EmotionTalk 落地与"跨语料库"实情（2026-11-08）

来源：[EmotionTalk](https://modelscope.cn/datasets/BAAI/Emotiontalk)（南开 NKU-HLT，CC BY-NC-SA 4.0）。19,250 条双人对话语音 / 19 位说话人 / 44.1kHz 双声道；本地 `<corpus>/EmotionTalk`（Audio.tar 14,811,722,752B，解压后 13.8GB）。

做过的四组实验（全部按"留一说话人"）：

| 训练数据 | 类别 | 特征 | LOO |
|---|---|---|---|
| CASIA（4 人 / 1,000 条 / 表演朗读） | 3 | rate, energyDb, zcr | 71.8% |
| EmotionTalk（19 人 / 14,811 条） | 3 | 全部 10 维 | 40.4% |
| EmotionTalk 高一致子集（8,193 条） | 3 | 全部 10 维 | 49.8% |
| CASIA → EmotionTalk（跨库） | 3 | rate, energyDb, zcr | 35.5% |
| CASIA + EmotionTalk-clean（23 人 / 8,793 条） | 3 | 全部 10 维 | 50.5% |

结论（重要）：

- **71.8% 是"同库同演员"的乐观值**，不能当作真实聊天准确率。换到 19 人对话语料，同口径只有 49.8%；跨库只有 35.5%。真实场景应按 **50–60%** 预期。
- **标签本身有噪声**：19,098 条里 **9,091 条（47.6%）** 五位标注员的多数类与 `emotion_result` 不一致；只留高一致片段后还剩 9,311 条。
- **"写出来的标签"精度低**：现役 CASIA 模型在 EmotionTalk-clean 上只有 24.5% 的话会写出语气，其中只有 22% 是对的 —— 说明它的"生气/低落"判据是表演腔的，迁不到对话。收紧阈值（margin 0.18→0.45）精度不升反降，属系统性偏差，不是阈值问题。
- 因此**线上继续用 CASIA 模型 + 现有闸门**（在他真实语音上至少给出过"疲惫/高兴"的对例），不切 EmotionTalk 模型（它几乎不说，说了也只有 35% 对）。
- 新的脚本：`ingest-emotiontalk.mjs`、`eval-cross.mjs`（跨库评估）、`filter-agreement.mjs`（按五票筛干净子集）、`probe-model.mjs`（覆盖率/精度摸底）、`sweep-gate.mjs`（阈值扫描）。
- 真正的下一步不是换语料，而是**他本人的 10–15 条带标签语音**：候选说话人的基线一换，判据才有意义。
## 0.8.0 —— 名字与输出格式（2026-11-08，按聊天里定的）

名字：**听潮**（她起的，意思是"把声音里的起伏记下来，跟听潮水一个意思"）。代码路径没改名，只在输出和文档里叫听潮。

输出从"只给一个结论词"改成"**基数 + 基础结论**"：

```
[语音 5秒｜示例用户｜听潮 语速0.86x 音量-2.4dB 音色1.12x → 像低落]
```

- 三个数字是**相对他自己平时**：语速 0.86x = 比平时慢；音量 -2.4dB = 比平时小；音色 1.12x = 更亮更紧。
- `→ 像…` 是系统的猜测，明确写成"像"，不是"他是"。
- 只有**质心判定**才给结论；原型库那套（实测 29%）从此只作诊断——11-08 实测它把"努力以 effort"判成"放松"、把一句英语判成"火"，已经确认不能给她贴标签。
- 太短（<1.5 秒或不到 5 个字）不摆数字、不下结论，只留 `[语音 2秒｜示例用户]`。
- 修掉两个渲染 bug：程度词重复两次（`72–100 72–100`）、理由串里出现 `音量·0.2dB` 这种缺值的怪样子。

她那边的人格补了一节【听潮】：数字是跟"他平时"比、`像…` 可推翻、判不准时只有数字要自己从字里判断、回复时别念数字。
## 0.8.1 —— 身份标注 + 「可能有点…（不确定）」（2026-11-08，主人要）

- 语音行带 QQ 号：`[语音 5秒｜示例用户(1000000000)｜听潮 …]`。群里语音一多，光看昵称会认错人；她那边人格写了「认人只认 QQ 号」。
- 系统没把握时不再沉默：质心判定 `low_margin`（领先幅度 < 0.18）会给一句 **`→ 可能有点生气（不确定）`**；服务端返回 `affect.hint{label,labelCN,margin}`，桥接只把它渲染成「可能」。
- 还在 `bootstrap`（前 3 条还没学出他平时怎么说话）时，数字也不显示——没有基线，数字没意义。
- 顺手修：`/analyze` 返回体里 `labelCN` 与 `labelCn` 两个键只差大小写，PowerShell 的 `ConvertFrom-Json` 会直接报「重复的键」；删掉 `labelCn`。
- 已清掉主人 `1000000000` 的旧基线（里面混过 SAPI 合成样本），下次 3 条真实语音重新学。

## 0.8.2 —— 生产模型换成「不看音量」的三键（2026-11-08）

**为什么换**：主人实测录音里，绝对音量（energyDb）在**同一天、同一部手机、同一个房间**内摆幅达 **12 dB**（−15.3 到 −27.6）。它测的是「手机离嘴多远 / 宿舍里有多吵」，不是情绪。以它为三键之一的旧模型（rate+energyDb+zcr，CASIA 留一 71.8%）会把「在宿舍小声说话」持续判成「低落」。

**换成什么**：`rate + pitchVar + pause`（语速比 / 音高起伏比 / 停顿比），三个都是**增益无关**的量，跟手机放多远无关。CASIA 留一 **65.5%**（比旧模型低 6.3 点，但换掉了 12 dB 的噪声源）。

| 组合 | LOO |
|---|---|
| rate + energyDb + zcr（旧） | 71.8% |
| `rate + pitchVar + pause`（现役） | **65.5%** |
| rate + pitchVar | 62.7% |
| rate + peakRate + pitchVar | 64.3% |
| rate + pitchVar + energyVar | 59.5% |

**阈值按类分开**（`model.json` 的 `minMarginByLabel`）：angry 0.20 / neutral 0 / **sad 0.30**。因为误报「低落」的社交代价最大——他只是在小声说话。

**输出**（三种，都带 QQ 号）：

```
[语音 5秒｜示例用户(1000000000)｜听潮 语速0.78x 音高起伏0.87x 停顿1.29x → 明显像生气] …
[语音 5秒｜…｜听潮 语速0.78x 音高起伏0.87x 停顿1.29x → 可能有点累（不确定）] …
[语音 5秒｜…｜听潮 语速0.78x 音高起伏0.87x 停顿1.29x] …
```

- 慢 + 停顿多（rate<0.92 且 pause>1.10）时，「可能有点低落」改成 **「可能有点累」**——真实使用里这个组合更常是累/没精神。
- 判不准（margin 不足）：只说「可能有点…（不确定）」。
- 样本落在半径外：只给三个数字，不下结论。

**回滚**：`Copy-Item data\model.rate-energyDb-zcr.bak-20261108.json data\model.json -Force`，然后重启 3098。

## 0.8.3 —— 转写换 Paraformer-large（2026-11-08）

**为什么换**：EmotionTalk 自然口语 101 条实测（同一批音频、同一台机器、10 线程）：

| 引擎 | 字错率 CER | 单句耗时 |
|---|---|---|
| paraformer-zh-small（原） | 21.2% | 40ms |
| paraformer-zh-large（现役） | 16.1% | 92ms |
| SenseVoice-small（41 条样本对照） | 10.6% | 102ms |

换 large 是「同样的接口、多 50ms、少 5 个字错」。SenseVoice 在 41 条样本上和 small 打平（10.6% vs 10.4%），但它自带标点与数字归一化（一千万写成阿拉伯数字），对 CER 不利、对我们的用途也没必要，所以没换。

**验证**：5 秒真实语音转写 174ms（含特征），文本「今天加班到九点别等我了我有点累」正确。
**回滚**：启动时设 EARS_PARA_DIR=./models\sherpa-onnx-paraformer-zh-small-2024-03-09。


## 0.8.4（2026-11-08）精简输出 + 私聊不重复标号

- 语音行从 81 字压到 50 字（私聊）/ 66 字（群聊）：
  `[语音 5秒｜示例用户｜听潮.90/1.89/1.17x → 像累?]`
  三个数固定顺序 = 语速 / 音高起伏 / 停顿，都是相对他本人基线。
- 不确定的结论用结尾问号标（`→ 像累?`），不再写「可能有点…（不确定）」。
- 私聊不再重复标 QQ 号（对话对象就是他）；群里仍带 `昵称(QQ号)`，防认错人。
- 缓存改成 LRU（上限 300 条、缓存键带发送者 QQ）；OneBot 不回 retcode 时不再误判失败。
- 端到端：2.1s，格式正确；token 估算 每条语音比同内容文字多约 14 token。


## 0.9.0 —— 并入 ESD（英文/中文，20 人，35,000 条）

- 数据：ESD \<corpus>/ESD\，20 个说话人（10 中文 + 10 英文）× 5 情绪 × 350 句 = 35,000 条，
  每条带官方转写 \<speaker>.txt\（因此语速是**真实字/秒**，不再用代理值）。
- 入库脚本 \ingest-esd.mjs\：跳过 \__MACOSX\、\._*\；必须先 \parseWav\ → \	o16kMono\ 再
  \nalyzeProsody\（直接喂 WAV Buffer 会得到 “almost no speech energy”）。
- 合并语料（CASIA 1,000 + ESD 35,000，24 个说话人）按说话人留一：

  | 特征 | 3 类准确率 | angry | neutral | sad |
  |---|---|---|---|---|
  | rate,pitchVar,pause（旧生产） | 55.9% | — | — | — |
  | rate,pitchVar,zcr | 62.3% | — | — | — |
  | **rate,pitchVar,zcr,hnr（现生产）** | **67.0%** | 56.5% | 75.4% | 68.7% |
  | +pause | 66.8% | — | — | — |
  | +pitchSlope / +tailTrend | 66.5% / 66.9% | — | — | — |

- 5 类（含 happy / excited）：默认 10 特征 47.6%，贪心 48.8%，neutral 75.5% 但 angry 只有 33.5%
  → **不上线**，happy/excited 继续只作为原型库的诊断输出。
- 含 energyDb 的模型在 ESD 上能到 71.8%，但 \exp-gain.mjs\ 证明它靠音量：测试集整体 −12 dB
  就从 58.9% 掉到 45.3%，neutral 命中率直接归零 → 生产不采用。
- 门槛（\	une-standards.mjs\ 在 CASIA 上校准）：angry 0.32 / sad 0.28 / 总 0.18。CASIA 上
  angry 最高精确率仅 46%，sad 59%，所以线上「说出口」的频率会很低——这是刻意的。

### 0.9.1 修的两个真 bug（2026-11-08 晚）

1. **基线先验混合过重**：\lib/affect.mjs\ 的 \effectiveBaseline\ 原来按 \
/10\ 与 PRIOR 混合，
   只有 3 条样本时 70% 用的是教科书先验（rate 4.6 / zcr 1500 / hnr 0），与真人差太远，
   导致正常朗读被判 \	oo_far\ 后回退到原型/规则（Neutral 全判 tired）。改为 \
>=3\ 就完全
   信本人基线。
2. **基线行没存 hnr**：\learnBaseline\ 只存 7 项，模型换成含 \hnr\ 的四键后，基线里 hnr 恒为 0，
   相对值凭空多出 3–4 个标准差 → 全部 too_far。现在存全部 11 项特征，并在启动时丢弃缺 \hnr\
   的旧基线行（少于 3 条就整段重建）。

回滚到旧模型：\copy data\model.casia3.bak-20261108.json data\model.json\ 后重启 3098。