// Prosody / affect estimation from 16 kHz mono PCM — v0.3
// Rule-based, explainable, 0 token, no model download.
//
// v0.3: robust pitch (subharmonic rejection + median filter), semitone IQR instead of
// std, speaking rate from ASR text, conservative scoring with a "neutral" fallback
// (when evidence is weak we say nothing rather than guess wrong).
//
// Output is a *tendency* + confidence; combine with chat context, never treat as fact.

const FRAME = 400 // 25 ms
const HOP = 160 // 10 ms
const PITCH_MIN = 60
const PITCH_MAX = 450
const CORR_MIN = 0.3

function rms(arr) {
  let s = 0
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i]
  return Math.sqrt(s / arr.length)
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[i]
}

function med(xs) {
  if (!xs.length) return 0
  return percentile([...xs].sort((a, b) => a - b), 0.5)
}

function iqr(xs) {
  if (xs.length < 4) return 0
  const s = [...xs].sort((a, b) => a - b)
  return percentile(s, 0.75) - percentile(s, 0.25)
}

// Pick the *smallest* lag whose correlation is close to the best one → avoids the
// classic "half the real pitch" (subharmonic) error of plain argmax autocorrelation.
function pitchFrame(frame, sr, minLag, maxLag) {
  let energy = 0
  for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i]
  if (energy <= 1e-9) return { hz: 0, corr: 0 }

  const corrs = new Float32Array(maxLag - minLag + 1)
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0
    for (let i = 0; i < frame.length - lag; i++) c += frame[i] * frame[i + lag]
    c /= energy
    corrs[lag - minLag] = c
    if (c > best) best = c
  }
  if (best < CORR_MIN) return { hz: 0, corr: best }

  const cutoff = best * 0.88
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corrs[lag - minLag] < cutoff) continue
    // local peak only
    const prev = lag > minLag ? corrs[lag - 1 - minLag] : -1
    const next = lag < maxLag ? corrs[lag + 1 - minLag] : -1
    if (corrs[lag - minLag] >= prev && corrs[lag - minLag] >= next) {
      return { hz: sr / lag, corr: corrs[lag - minLag] }
    }
  }
  return { hz: sr / (minLag + corrs.indexOf(best)), corr: best }
}

function medianFilter(values, win = 5) {
  return values.map((_, i) => {
    const half = Math.floor(win / 2)
    const slice = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1))
    return med(slice)
  })
}

export function analyzeProsody(samples, sampleRate = 16000, opts = {}) {
  const text = String(opts.text || '')
  const frames = []
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    frames.push({ t: start / sampleRate, rms: rms(samples.subarray(start, start + FRAME)) })
  }
  if (!frames.length) return { ok: false, reason: 'audio too short' }

  const rmsSorted = frames.map((f) => f.rms).sort((a, b) => a - b)
  const noise = percentile(rmsSorted, 0.2)
  const loud = percentile(rmsSorted, 0.95)
  const thresh = Math.max(noise * 3, loud * 0.12, 0.006)

  const voiced = frames.filter((f) => f.rms >= thresh)
  if (voiced.length < 4) {
    return {
      ok: true,
      duration: Number((samples.length / sampleRate).toFixed(2)),
      voicedRatio: 0,
      label: 'quiet',
      confidence: 0.3,
      features: { note: 'almost no speech energy' },
    }
  }

  const minLag = Math.floor(sampleRate / PITCH_MAX)
  const maxLag = Math.floor(sampleRate / PITCH_MIN)
  const rawPitch = []
  const corrs = []
  for (const f of voiced) {
    const idx = Math.round(f.t * sampleRate)
    const { hz, corr } = pitchFrame(samples.subarray(idx, idx + FRAME), sampleRate, minLag, maxLag)
    rawPitch.push(hz)
    corrs.push(corr)
  }

  // keep voiced frames, median-filter the pitch track, drop outliers
  const smoothed = medianFilter(rawPitch, 5)
  const center = med(smoothed.filter((p) => p > 0))
  const track = []
  for (let i = 0; i < voiced.length; i++) {
    const p = smoothed[i]
    if (p <= 0) continue
    const st = 12 * Math.log2(p / Math.max(1, center))
    if (Math.abs(st) > 5) continue
    track.push({ t: voiced[i].t, hz: p })
  }
  const hz = track.map((x) => x.hz)
  const pitchMed = med(hz)
  const semis = hz.map((p) => 12 * Math.log2(p / Math.max(1, pitchMed)))
  const pitchSpread = iqr(semis)
  const sortedSemis = [...semis].sort((a, b) => a - b)
  const pitchRange = percentile(sortedSemis, 0.9) - percentile(sortedSemis, 0.1)

  // jitter: frame-to-frame pitch movement (semitone steps), a proxy for vocal tension
  let jitter = 0
  if (track.length >= 3) {
    let sum = 0
    for (let i = 1; i < track.length; i++) {
      sum += Math.abs(12 * Math.log2(track[i].hz / Math.max(1, track[i - 1].hz)))
    }
    jitter = sum / (track.length - 1)
  }

  const energies = voiced.map((f) => Math.log10(f.rms + 1e-6))
  const eMean = energies.reduce((a, b) => a + b, 0) / energies.length
  const eSd = Math.sqrt(energies.reduce((a, b) => a + (b - eMean) ** 2, 0) / energies.length)
  const energyDb = 20 * eMean

  // zero-crossing rate over voiced frames ≈ spectral brightness (breathy vs pressed voice)
  let zc = 0
  let zcSamples = 0
  for (const f of voiced) {
    const idx = Math.round(f.t * sampleRate)
    const seg = samples.subarray(idx, idx + FRAME)
    for (let i = 1; i < seg.length; i++) if ((seg[i - 1] < 0) !== (seg[i] < 0)) zc++
    zcSamples += seg.length - 1
  }
  const zcr = zcSamples > 0 ? (zc / zcSamples) * sampleRate : 0

  const first = voiced[0].t
  const last = voiced[voiced.length - 1].t
  const span = Math.max(0.001, last - first + FRAME / sampleRate)
  const inSpan = frames.filter((f) => f.t >= first && f.t <= last)
  const pauseRatio = inSpan.length ? 1 - voiced.length / inSpan.length : 0

  // ---- v0.4: contour shape / rhythm / voice quality -------------------------
  // 之前的 7 维只看"起伏有多大"，看不出"往上还是往下"。
  // 高兴是往上扬的，低落/委屈是往下掉的——所以这里补三条走向类特征。
  const pts = track.map((x) => ({ t: x.t, st: 12 * Math.log2(x.hz / Math.max(1, pitchMed)) }))
  // 斜率在半秒的短片段上会爆掉（±30 st/s），物理上人声不会这样，截到 ±12
  const clampSt = (v) => Math.max(-12, Math.min(12, v))
  const slopeOf = (arr) => {
    if (arr.length < 5) return 0
    const slopes = []
    const step = Math.max(1, Math.floor(arr.length / 40))
    for (let i = 0; i < arr.length; i += step) {
      for (let j = i + step; j < arr.length; j += step) {
        const dt = arr[j].t - arr[i].t
        if (dt >= 0.08) slopes.push((arr[j].st - arr[i].st) / dt)
      }
    }
    return slopes.length ? med(slopes) : 0
  }
  const pitchSlope = clampSt(slopeOf(pts))
  const tailTrend = clampSt(slopeOf(pts.filter((p) => p.t >= last - 0.25)))

  // rhythm: count energy peaks on the smoothed RMS envelope ≈ syllables
  const env = inSpan.map((f) => f.rms)
  const smoothEnv = env.map((_, i) => {
    const s = env.slice(Math.max(0, i - 2), Math.min(env.length, i + 3))
    return s.reduce((a, b) => a + b, 0) / s.length
  })
  const minGap = Math.max(2, Math.round((0.08 * sampleRate) / HOP))
  const peaks = []
  for (let i = 1; i < smoothEnv.length - 1; i++) {
    if (smoothEnv[i] < thresh) continue
    if (smoothEnv[i] < smoothEnv[i - 1] || smoothEnv[i] < smoothEnv[i + 1]) continue
    if (peaks.length && i - peaks[peaks.length - 1] < minGap) {
      if (smoothEnv[i] > smoothEnv[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i
      continue
    }
    peaks.push(i)
  }
  const peakRate = peaks.length / Math.max(0.3, span)

  // HNR from the autocorrelation peak: how periodic (clean/pressed) vs noisy (breathy)
  const hnrFrames = corrs.filter((c) => c >= 0.35 && c <= 0.985).map((c) => 10 * Math.log10(c / (1 - c)))
  const hnr = hnrFrames.length ? hnrFrames.reduce((a, b) => a + b, 0) / hnrFrames.length : 0

  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = (text.match(/[A-Za-z][A-Za-z'-]*/g) || []).length
  const units = cjk || words
  const rate = units > 0 ? units / span : (voiced.length / inSpan.length) * 4

  // tail drop over the last 25 % of speech
  let tailDrop = 0
  if (track.length >= 8) {
    const cut = last - span * 0.25
    const head = track.filter((x) => x.t < cut).map((x) => x.hz)
    const tail = track.filter((x) => x.t >= cut).map((x) => x.hz)
    if (head.length >= 2 && tail.length >= 2) tailDrop = 12 * Math.log2(med(head) / Math.max(1, med(tail)))
  }

  const features = {
    duration: Number((samples.length / sampleRate).toFixed(2)),
    speechSeconds: Number(span.toFixed(2)),
    pitchHz: Math.round(pitchMed),
    pitchIQR: Number(pitchSpread.toFixed(2)),
    pitchRange: Number(pitchRange.toFixed(2)),
    jitter: Number(jitter.toFixed(3)),
    energyCV: Number(eSd.toFixed(3)),
    energyDb: Number(energyDb.toFixed(1)),
    zcr: Math.round(zcr),
    rate: Number(rate.toFixed(2)),
    rateUnit: cjk ? '字/秒' : words ? '词/秒' : 'proxy',
    pauseRatio: Number(pauseRatio.toFixed(3)),
    tailDrop: Number(tailDrop.toFixed(2)),
    pitchSlope: Number(pitchSlope.toFixed(2)),
    tailTrend: Number(tailTrend.toFixed(2)),
    peakRate: Number(peakRate.toFixed(2)),
    hnr: Number(hnr.toFixed(1)),
    voicedRatio: Number((voiced.length / Math.max(1, inSpan.length)).toFixed(3)),
    pitchFrames: track.length,
  }

  // additive scores are kept for diagnostics / calibration only
  const s = { happy: 0, tired: 0, sad: 0, relaxed: 0, excited: 0, angry: 0 }
  if (rate >= 4.8 && pitchSpread >= 1.6) s.happy += 0.5 + Math.min(0.3, (rate - 4.8) * 0.15)
  if (rate >= 5.4 && pitchSpread >= 2.4 && eSd >= 0.34) s.excited += 0.85
  if (rate <= 4.0) s.tired += 0.4
  if (pauseRatio >= 0.3) s.tired += 0.35
  if (eSd <= 0.27) s.tired += 0.2
  if (pitchSpread <= 1.6) s.tired += 0.2
  if (tailDrop >= 1.1 && rate <= 4.8) s.sad += 0.45
  if (rate <= 4.2 && pauseRatio <= 0.45) s.sad += 0.2
  if (eSd <= 0.3) s.sad += 0.15
  if (rate >= 3.2 && rate <= 5.2) s.relaxed += 0.3
  if (pitchSpread <= 1.5) s.relaxed += 0.35
  if (pauseRatio >= 0.15 && pauseRatio <= 0.42) s.relaxed += 0.2
  if (Math.abs(tailDrop) <= 1.0) s.relaxed += 0.15
  if (eSd >= 0.45 && pitchSpread >= 2.4) s.angry += 0.55
  if (rate >= 5.2 && eSd >= 0.4) s.angry += 0.2

  // ---- decision tree (ordered; first match wins) ---------------------------
  // Prosody alone cannot reliably separate 疲惫 / 委屈 / 平静; we only claim a label
  // when the pattern is distinctive, otherwise stay neutral (bridge injects nothing).
  let label = 'neutral'
  let confidence = 0.3
  let rule = 'no_strong_pattern'

  if (rate >= 5.2 && pitchSpread >= 2.2) {
    label = 'excited'; rule = 'fast_wide_pitch'
    confidence = 0.6 + Math.min(0.15, (rate - 5.2) * 0.1)
  } else if (rate >= 4.6 && pitchSpread >= 1.5) {
    label = 'happy'; rule = 'brisk_varied_pitch'
    confidence = 0.55 + Math.min(0.2, (rate - 4.6) * 0.12)
  } else if (tailDrop >= 2.4 && rate <= 4.8 && eSd <= 0.36) {
    label = 'sad'; rule = 'drooping_tail'
    confidence = 0.5 + Math.min(0.2, (tailDrop - 2.4) * 0.1)
  } else if (rate <= 4.2 && pauseRatio >= 0.30 && eSd <= 0.34 && pitchSpread <= 2.2) {
    label = 'tired'; rule = 'slow_paused_flat'
    confidence = 0.5 + Math.min(0.2, (pauseRatio - 0.30) * 0.4)
  } else if (pitchSpread <= 1.6 && rate >= 3.0 && rate <= 5.2 && pauseRatio <= 0.45) {
    label = 'relaxed'; rule = 'narrow_pitch_even'
    confidence = 0.5 + Math.min(0.15, (1.6 - pitchSpread) * 0.1)
  }

  return {
    ok: true,
    label,
    confidence: Number(Math.min(0.8, confidence).toFixed(2)),
    rule,
    features,
    scores: s,
  }
}