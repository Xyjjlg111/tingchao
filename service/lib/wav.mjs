// Minimal RIFF/WAVE reader + mono 16k resampler.
// Supports PCM 8/16/24/32-bit int and 32-bit float. Returns Float32Array in [-1, 1].

export function parseWav(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        audioFormat: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bitsPerSample: b.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = b.subarray(body, Math.min(body + size, b.length))
    }
    off = body + size + (size & 1)
  }
  if (!fmt) throw new Error('missing fmt chunk')
  if (!data) throw new Error('missing data chunk')

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt
  const bytes = bitsPerSample >> 3
  const frames = Math.floor(data.length / (bytes * channels))
  const out = new Float32Array(frames)

  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes
      let v
      if (audioFormat === 3 && bitsPerSample === 32) v = data.readFloatLE(p)
      else if (bitsPerSample === 16) v = data.readInt16LE(p) / 32768
      else if (bitsPerSample === 8) v = (data.readUInt8(p) - 128) / 128
      else if (bitsPerSample === 24) v = data.readIntLE(p, 3) / 8388608
      else if (bitsPerSample === 32) v = data.readInt32LE(p) / 2147483648
      else throw new Error(`unsupported bitsPerSample=${bitsPerSample}`)
      sum += v
    }
    out[i] = sum / channels
  }

  return { sampleRate, channels, bitsPerSample, samples: out, duration: frames / sampleRate }
}

// Simple linear resampler to 16 kHz (whisper.cpp expects 16k mono float).
export function to16kMono(samples, sampleRate) {
  if (sampleRate === 16000) return samples
  const ratio = sampleRate / 16000
  const n = Math.floor(samples.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const t = x - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return out
}
