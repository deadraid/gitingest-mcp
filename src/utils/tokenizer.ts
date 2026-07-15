import { Tiktoken } from 'js-tiktoken/lite';

export const tokenizerEncodings = ['o200k_base', 'cl100k_base'] as const;
export type TokenizerEncoding = (typeof tokenizerEncodings)[number];

const tokenizerPromises = new Map<TokenizerEncoding, Promise<Tiktoken>>();

export function getTokenizer(encoding: TokenizerEncoding): Promise<Tiktoken> {
  const existing = tokenizerPromises.get(encoding);
  if (existing) return existing;

  const tokenizerPromise = loadTokenizer(encoding);
  tokenizerPromises.set(encoding, tokenizerPromise);
  return tokenizerPromise;
}

export function encodeText(tokenizer: Tiktoken, value: string): number[] {
  return tokenizer.encode(value, [], []);
}

export function countTextTokens(tokenizer: Tiktoken, value: string): number {
  return encodeText(tokenizer, value).length;
}

export function decodeCompleteTokenPrefix(
  tokenizer: Tiktoken,
  tokens: number[]
): { text: string; tokenCount: number } {
  for (let removedTokens = 0; removedTokens <= 3; removedTokens += 1) {
    const tokenCount = tokens.length - removedTokens;
    if (tokenCount < 0) break;
    const candidateTokens = tokens.slice(0, tokenCount);
    const text = tokenizer.decode(candidateTokens);
    if (!text.endsWith('\uFFFD')) {
      return { text, tokenCount };
    }

    // A real replacement character round-trips to the same token sequence;
    // one introduced by cutting a UTF-8 byte sequence does not.
    const roundTripTokens = encodeText(tokenizer, text);
    if (
      roundTripTokens.length === candidateTokens.length &&
      roundTripTokens.every((token, index) => token === candidateTokens[index])
    ) {
      return { text, tokenCount };
    }
  }

  return { text: '', tokenCount: 0 };
}

async function loadTokenizer(encoding: TokenizerEncoding): Promise<Tiktoken> {
  const ranks =
    encoding === 'o200k_base'
      ? (await import('js-tiktoken/ranks/o200k_base')).default
      : (await import('js-tiktoken/ranks/cl100k_base')).default;
  return new Tiktoken(ranks);
}
