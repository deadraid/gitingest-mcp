import { describe, expect, it } from 'vitest';

import {
  buildTree,
  countDirectories,
  renderTree,
} from '../../src/utils/index.js';
import {
  decodeCompleteTokenPrefix,
  getTokenizer,
} from '../../src/utils/tokenizer.js';

describe('repository tree utilities', () => {
  it('sorts directories before files and renders correct connectors', () => {
    // Arrange
    const files = [
      { path: 'z.txt', content: '', size: 0, type: 'file' as const },
      { path: 'src/b.ts', content: '', size: 0, type: 'file' as const },
      { path: 'src/a.ts', content: '', size: 0, type: 'file' as const },
    ];

    // Act
    const tree = buildTree(files);
    const rendered = renderTree(tree);
    const directoryCount = countDirectories(tree);

    // Assert
    expect(rendered).toBe(
      ['├── src/', '│   ├── a.ts', '│   └── b.ts', '└── z.txt'].join('\n')
    );
    expect(directoryCount).toBe(1);
  });

  it('handles deeply nested trees without recursive stack growth', () => {
    // Arrange
    const depth = 2000;
    const path = `${Array.from({ length: depth }, (_, index) => `d${index}`).join('/')}/file.txt`;
    const files = [{ path, content: '', size: 0, type: 'file' as const }];

    // Act
    const tree = buildTree(files);
    const directoryCount = countDirectories(tree);
    const rendered = renderTree(tree, '', 2000);

    // Assert
    expect(directoryCount).toBe(depth);
    expect(rendered.length).toBeLessThanOrEqual(2000);
    expect(rendered).toContain('d0/');
  });

  it('bounds rendering for wide repository trees', () => {
    // Arrange
    const files = Array.from({ length: 10_000 }, (_, index) => ({
      path: `src/file-${index.toString().padStart(5, '0')}.ts`,
      content: '',
      size: 0,
      type: 'file' as const,
    }));

    // Act
    const tree = buildTree(files);
    const rendered = renderTree(tree, '', 10_000);

    // Assert
    expect(rendered.length).toBeLessThanOrEqual(10_000);
    expect(rendered).toContain('[tree truncated]');
  });

  it('does not decode a partial multi-byte token as replacement text', async () => {
    // Arrange
    const tokenizer = await getTokenizer('cl100k_base');
    const emojiTokens = tokenizer.encode('𐍈', [], []);
    const replacementTokens = tokenizer.encode('\uFFFD', [], []);

    // Act
    const partialEmoji = decodeCompleteTokenPrefix(
      tokenizer,
      emojiTokens.slice(0, 3)
    );
    const realReplacement = decodeCompleteTokenPrefix(
      tokenizer,
      replacementTokens
    );

    // Assert
    expect(partialEmoji.text).toBe('');
    expect(partialEmoji.tokenCount).toBe(0);
    expect(realReplacement.text).toBe('\uFFFD');
    expect(realReplacement.tokenCount).toBe(replacementTokens.length);
  });
});
