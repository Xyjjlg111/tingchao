import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// 端到端集成测试（不碰生产）：
//   假的 OneBot 网关（/get_record_text 失败、/get_record 返回样例 wav 的 base64）
//   → voice-ears.describe() → 本机 3098 的 whisper + 韵律 → 打印最终注入文本
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { createVoiceEars } from 'file:///F:/qq-bridge/src/voice-ears.js'

const wav = readFileSync(process.env.SAMPLE || join(dirname(fileURLToPath(import.meta.url)), 'samples', 'zh-tired.wav'))
const b64 = wav.toString('base64')

const fake = http.createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (url.startsWith('/get_record_text')) {
      // 模拟 QQ 自带转文字不可用
      return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'no ptt text' }))
    }
    if (url.startsWith('/get_record')) {
      const params = JSON.parse(body || '{}')
      console.log('  fake gateway got get_record', JSON.stringify(params))
      return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file: params.file, out_format: 'wav', base64: b64 } }))
    }
    res.statusCode = 404
    res.end('{}')
  })
})

await new Promise((r) => fake.listen(3199, '127.0.0.1', r))
console.log('fake gateway on 3199')

const cfg = {
  snowluma: { httpUrl: 'http://127.0.0.1:3199', accessToken: 'test-token' },
  socialV2: { voice: { ears: { enabled: true, serviceUrl: 'http://127.0.0.1:3098', emotion: true } } }
}

const ears = createVoiceEars({ cfg, log: (...a) => console.log('  [log]', ...a) })
const t0 = Date.now()
const desc = await ears.describe({ file: 'abc.amr' }, { messageId: 12345, senderName: '测试用户', senderQq: '1000000000' })
console.log('\n--- 注入结果 ---')
console.log(desc)
console.log(`耗时 ${Date.now() - t0} ms`)
console.log('stats', JSON.stringify(ears.stats()))

fake.close()
