import { bench, describe } from 'vitest'

function createShiftBuffer(max) {
  const arr = []
  return {
    push(sample) {
      arr.push(sample)
      if (arr.length > max) arr.shift()
    }
  }
}

function createRingBuffer(max) {
  const buf = new Array(max)
  let count = 0
  let cursor = 0
  return {
    push(sample) {
      buf[cursor] = sample
      cursor = (cursor + 1) % max
      count = Math.min(max, count + 1)
    }
  }
}

describe('监测历史缓存写入性能', () => {
  bench('数组 push+shift', () => {
    const b = createShiftBuffer(4000)
    for (let i = 0; i < 20000; i++) b.push(i)
  })

  bench('环形缓冲区', () => {
    const b = createRingBuffer(4000)
    for (let i = 0; i < 20000; i++) b.push(i)
  })
})
