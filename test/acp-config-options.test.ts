import { describe, expect, test } from 'bun:test';
import { modelsFromConfigOptions } from '../src/acp-client.ts';

describe('modelsFromConfigOptions', () => {
  test('category=model の select からモデル一覧と現在値を取り出す（グループも平らにする）', () => {
    const r = modelsFromConfigOptions([
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build' }] },
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'a/x',
        options: [{ value: 'a/x', name: 'X' }, { group: 'g', name: 'G', options: [{ value: 'b/y' }] }],
      },
    ]);
    expect(r).toEqual({ configId: 'model', available: ['a/x', 'b/y'], current: 'a/x' });
  });

  test('モデルの選択肢が無ければ undefined', () => {
    expect(modelsFromConfigOptions(undefined)).toBeUndefined();
    expect(modelsFromConfigOptions([{ id: 'mode', category: 'mode', type: 'select', options: [] }])).toBeUndefined();
  });
});
