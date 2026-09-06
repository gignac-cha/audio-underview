import { oauthProviderIDs } from '@audio-underview/schemas';
import { describe, expect, it } from 'vitest';
import { getProviderStrategy, providerStrategies } from '../sources/registry.ts';

describe('provider registry', () => {
  it('10개 provider가 전부 등록되어 있다', () => {
    expect(Object.keys(providerStrategies).sort()).toEqual([...oauthProviderIDs].sort());
  });

  it('registry 키와 strategy.id가 일치한다', () => {
    for (const [key, strategy] of Object.entries(providerStrategies)) {
      expect(strategy.id).toBe(key);
    }
  });

  it('getProviderStrategy가 등록된 strategy를 돌려준다', () => {
    for (const id of oauthProviderIDs) {
      expect(getProviderStrategy(id)).toBe(providerStrategies[id]);
    }
  });
});
