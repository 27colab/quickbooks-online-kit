import type { StoredTokens, TokenStore } from '../types.js';

export class MemoryTokenStore implements TokenStore {
  private value: StoredTokens | null;
  constructor(initial: StoredTokens | null = null) {
    this.value = initial ? { ...initial } : null;
  }
  async get() {
    return this.value ? { ...this.value } : null;
  }
  async set(tokens: StoredTokens) {
    this.value = { ...tokens };
  }
  async delete() {
    this.value = null;
  }
}
