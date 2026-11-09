# 怎么用

## 只想要「语音 → 文字」

```cmd
curl -X POST --data-binary "@samples\zh-tired.wav" http://127.0.0.1:3098/asr
```

## 想要「文字 + 语气」

```cmd
curl -X POST --data-binary "@samples\zh-sad.wav" "http://127.0.0.1:3098/analyze?speaker=10001"
```

返回里：

- `asr.text`：转写
- `affect.label`：angry / neutral / sad（或 low_margin / too_far / bootstrap）
- `affect.centroid.margin`：有多确定
- `affect.standard`：这次用的是谁的标准（person / group / default）

## 接口一览（全部 127.0.0.1）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | /health | 状态、引擎、模型、基线人数 |
| POST | /asr | 只要文字 |
| POST | /affect | 只要语气（?speaker=） |
| POST | /analyze | 两个都要（?speaker=&group=） |
| GET | /baselines | 每个人学到的基线 |
| POST | /baseline/reset?speaker= | 清掉某个人的基线 |
| GET | /standards | 判断标准（面板用） |
| POST | /standards | 增改标准（qq 或 gid） |
| POST | /standards/delete | 删除标准 |
| GET | /standards/derive?speaker=&days=7 | 按最近语音生成初稿 |
| GET | /eco | 是否处于省电暂停 |

## 省电

如果 3098 被别的程序停掉（比如省电脚本），面板会显示「听潮已暂停」；
设置环境变量 `EARS_ECO_FILE` 指向你的省电状态 json，`/eco` 才会读它（没有就永远 false）。
