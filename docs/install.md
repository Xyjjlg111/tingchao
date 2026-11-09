# 安装（Windows，约 20 分钟）

> 这个包分两块：**耳朵服务**（Node 进程，负责听懂语音、判语气）和 **DSH 面板**（设置在 DSH 里，管每个人的门槛）。
> 只用耳朵、不接 QQ 也能跑；要接 QQ 需要 DSH + qq-bridge，那部分不在本包内。

## 0. 先准备

- Windows 10/11 x64
- Node.js **20.18 或更高**（`node -v` 看版本）
- 磁盘：代码 ~1 MB + **模型已自带 368.7 MB** + 依赖 ~200 MB
- **不需要 Python**，不需要 GPU

## 1. 放好文件

把整个 `01_ears-service` 放到一个**没有中文和空格**的路径下，例如：

```
D:\tingchao\ears
```

> 路径里有中文也能跑，只是模型加载偶尔会踩编码坑，能避免就避免。

## 2. 装依赖

```cmd
cd /d D:\tingchao\ears
npm install
```

装完会看到 `node_modules`（约 200 MB）。国内慢可以换源：

```cmd
npm config set registry https://registry.npmmirror.com
```

## 3. 模型（本包已自带，可跳过）

`models/` 里已经放好三份，**不用下载**：

| 目录 / 文件 | 大小 | 用途 |
|---|---|---|
| `paraformer-zh-large/` | 232.2 MB | **默认引擎**，中文，单句约 92 ms |
| `sherpa-onnx-paraformer-zh-small-2024-03-09/` | 79.5 MB | 轻量备用（想省 150 MB 时把 large 删掉，再把 `EARS_PARA_DIR` 指到它） |
| `ggml-base-q5_1.bin` | 56.9 MB | 多语种回退（whisper） |

只有在文件缺失、或想重新下载时才用：

```cmd
cd /d <解压后的分包根目录>
powershell -ExecutionPolicy Bypass -File 04_tools\download-models.ps1 -Which paraformer-large
```

脚本会校验文件大小；国内走 `hf-mirror.com`（ModelScope 的直链会返回 5 KB 错误页，已不用）。

## 4. 试跑

```cmd
node server.mjs
```

看到 `ears listening on 127.0.0.1:3098` 就成了。另开一个窗口：

```cmd
curl http://127.0.0.1:3098/health
```

## 5. 面板（可选，需要 DSH）

1. 把 `02_dsh-panel\dsh-tingchao` 放到任意目录，例如 `D:\tingchao\dsh-tingchao`；
2. 在你的 DSH profile（`<DSH_HOME>\profiles\desktop\package.json`）里：
   - `dependencies` 加 `"dsh-tingchao": "link:D:/tingchao/dsh-tingchao"`
   - `dsh.profile.bundles` 数组里加 `"dsh-tingchao"`
3. 在 profile 目录执行 `pnpm install --offline`（离线装不上时，直接建目录链接：
   `cmd /c mklink /J node_modules\dsh-tingchao D:\tingchao\dsh-tingchao`）
4. 重启 DSH → 设置里出现「听潮」。

> 面板只是读写 3098 的 `/standards`；耳朵没起时面板会显示「读不到」，不会崩。

## 6. 接 QQ（可选）

本包不含 qq-bridge。接法是在你的桥接里，把收到的 `record`（语音）消息体 POST 到：

```
POST http://127.0.0.1:3098/analyze?speaker=<对方QQ>&group=<群号，可选>
body: 原始音频（wav 最佳；amr/silk 需先转 wav）
```

返回里 `asr.text` 是转写，`affect` 是语气。把这两样拼成一行注入给模型即可。
