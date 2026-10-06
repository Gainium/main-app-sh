process.env.NODE_ENV = 'testing'

/**
 * The generic DataGrid mapping's text operators (bot lists, global
 * variables, …). Values are URI-encoded on the way in; the text operators
 * must still compare what the user typed, so a name holding a space can be
 * found, and the negations ("Is none of", "Not contains") must apply.
 */
import { expect } from 'chai'
import { mapDataGridOptionsToMongoOptions } from './utils'

const cond = (operator: string, value: string) => {
  const { filter } = mapDataGridOptionsToMongoOptions({
    filterModel: { items: [{ field: 'settings.name', operator, value }] },
  })
  return (filter.$and as any[])[0]['settings.name']
}

describe('DataGrid text filters', () => {
  it('contains / equals / startsWith / endsWith match a name with spaces', () => {
    expect(cond('contains', 'My bot').$regex.test('a My bot 2')).to.equal(true)
    expect(cond('equals', 'My bot')).to.deep.equal({ $eq: 'My bot' })
    expect(cond('startsWith', 'My b').$regex.test('My bot')).to.equal(true)
    expect(cond('endsWith', 'y bot').$regex.test('My bot')).to.equal(true)
  })

  it('isAnyOf / isNoneOf decode every listed name', () => {
    expect(cond('isAnyOf', 'My big bot,Grid/USDT')).to.deep.equal({
      $in: ['My big bot', 'Grid/USDT'],
    })
    expect(cond('isNoneOf', 'My big bot,Kraken')).to.deep.equal({
      $nin: ['My big bot', 'Kraken'],
    })
  })

  it('notContains is a negated, escaped, case-insensitive match', () => {
    const c = cond('notContains', 'a.b')
    expect(c.$not.source).to.equal('a\\.b')
    expect(c.$not.flags).to.equal('i')
  })
})
