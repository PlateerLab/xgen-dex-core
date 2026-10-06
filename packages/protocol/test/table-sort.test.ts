/**
 * 표 미리보기의 열 정렬: 머리를 누를 때마다 오름차순 → 내림차순 → 정렬 없음, 수는 수로, 빈 칸은 늘 아래.
 */
import assert from 'assert'
import { test } from 'node:test'
import { nextTableSort, sortedRowOrder, type TableSort } from '@dex/protocol/file-view'

test('같은 열을 누를 때마다 오름차순 → 내림차순 → 정렬 없음, 다른 열은 오름차순부터', () => {
  let s: TableSort = null
  s = nextTableSort(s, 2)
  assert.deepEqual(s, { col: 2, dir: 'asc' })
  s = nextTableSort(s, 2)
  assert.deepEqual(s, { col: 2, dir: 'desc' })
  s = nextTableSort(s, 2)
  assert.equal(s, null)
  assert.deepEqual(nextTableSort({ col: 2, dir: 'desc' }, 0), { col: 0, dir: 'asc' })
})

test('정렬이 없으면 파일 순서 그대로', () => {
  assert.deepEqual(sortedRowOrder([['b'], ['a']], null), [0, 1])
})

test('수 열은 수로 비교한다(문자 순서면 10 이 2 앞에 온다)', () => {
  const rows = [['10'], ['2'], ['-3'], ['7.25'], ['1e2']]
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'asc' }), [2, 1, 3, 0, 4])
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'desc' }), [4, 0, 3, 1, 2])
})

test('글자 열은 자연 순서로(한국어 순서: 한글이 먼저, 대소문자 구분 없이) 비교한다', () => {
  const rows = [['a10'], ['a2'], ['나'], ['가'], ['B']]
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'asc' }).map((i) => rows[i][0]), ['가', '나', 'a2', 'a10', 'B'])
})

test('빈 칸은 방향과 상관없이 늘 맨 아래이고, 같은 값은 원래 순서를 지킨다', () => {
  const rows = [['3', 'x'], ['', 'y'], ['1', 'z'], ['3', 'w'], ['  ', 'v']]
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'asc' }), [2, 0, 3, 1, 4])
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'desc' }), [0, 3, 2, 1, 4])
})

test('수와 글자가 섞인 열은 글자로, 모자란 칸은 빈 칸으로 본다', () => {
  const rows = [['C85'], ['10'], ['A6'], []]
  assert.deepEqual(sortedRowOrder(rows, { col: 0, dir: 'asc' }), [1, 2, 0, 3])
})
