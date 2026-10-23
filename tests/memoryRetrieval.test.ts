import { describe, expect, it } from 'vitest'
import { rankMemoryCandidates } from '../electron/main/r1/memoryRetrieval'
describe('bounded phrase recall', () => {
  it('keeps negated preference words searchable instead of treating 喜欢 as lookup noise', () => {
    const rows = [{ content: '用户不喜欢香菜。' }, { content: '用户喜欢无糖茶。' }]
    const result = rankMemoryCandidates(rows, '点菜时不喜欢的配料', { limit: 5, assertBudget() {} })
    expect(result[0]?.content).toBe('用户不喜欢香菜。')
    const avoided = rankMemoryCandidates(rows, '点菜时希望避开的配料', { limit: 5, assertBudget() {} })
    expect(avoided[0]?.content).toBe('用户不喜欢香菜。')
  })
  it('does not return every row for an unrelated query', () => {
    const rows = [{ content: '用户不喜欢香菜。' }, { content: '用户喜欢无糖茶。' }]
    expect(rankMemoryCandidates(rows, '今天天气怎么样', { limit: 5, assertBudget() {} })).toEqual([])
  })
})
