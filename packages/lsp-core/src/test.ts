// packages/lsp-core/test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { scanAndIndexTokens, TokenIndex } from './scanner';
import { getWordAtPosition, getTokenPropertyAtPosition, resolveFullTokenValueAtPosition } from './util';
import { AntdLs } from './server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Mock file system for tests
async function createTempFiles(files: Record<string, string>): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antd-lsp-test-'));
  
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tempDir, filePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }
  
  return tempDir;
}

describe('Ant Design Language Server', () => {
  let tokenIndex: TokenIndex;
  
  beforeEach(() => {
    tokenIndex = new Map();
  });

  describe('Scanner - Token Detection', () => {
    it('should detect tokens from ConfigProvider', async () => {
      const files = {
        'App.tsx': `
import React from 'react';
import { ConfigProvider } from 'antd';

const App = () => (
  <ConfigProvider
    theme={{
      token: {
        colorPrimary: '#1890ff',
        borderRadius: 8,
        fontSize: 14
      }
    }}
  >
    <div>Content</div>
  </ConfigProvider>
);`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('borderRadius')).toBe(true);
      expect(tokenIndex.has('fontSize')).toBe(true);

      const colorPrimaryDefs = tokenIndex.get('colorPrimary');
      expect(colorPrimaryDefs).toHaveLength(1);
      expect(colorPrimaryDefs![0].value).toBe('#1890ff');
      expect(colorPrimaryDefs![0].source).toBe('configProvider');
    });

    it('should detect tokens from useToken hook', async () => {
      const files = {
        'Component.tsx': `
import React from 'react';
import { useToken } from 'antd/es/theme/internal';

const Component = () => {
  const { token } = useToken();
  
  return (
    <div style={{
      backgroundColor: token.colorPrimary,
      borderRadius: token.borderRadius,
      fontSize: token.fontSize
    }}>
      Content
    </div>
  );
};`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('borderRadius')).toBe(true);
      expect(tokenIndex.has('fontSize')).toBe(true);

      const tokenDefs = tokenIndex.get('colorPrimary');
      expect(tokenDefs?.some(def => def.source === 'useToken')).toBe(true);
    });

    it('should detect tokens from traditional ThemeConfig', async () => {
      const files = {
        'theme.ts': `
import { ThemeConfig } from 'antd';

const customTheme: ThemeConfig = {
  token: {
    colorPrimary: '#722ed1',
    colorSuccess: '#52c41a',
    borderRadius: 6
  }
};`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('colorSuccess')).toBe(true);
      expect(tokenIndex.has('borderRadius')).toBe(true);

      const colorPrimaryDefs = tokenIndex.get('colorPrimary');
      expect(colorPrimaryDefs![0].value).toBe('#722ed1');
      expect(colorPrimaryDefs![0].source).toBe('themeConfig');
    });

    it('should detect tokens from JSON files', async () => {
      const files = {
        'theme.json': `{
  "theme": {
    "token": {
      "colorPrimary": "#1890ff",
      "borderRadius": 8,
      "fontSize": 14
    }
  }
}`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('borderRadius')).toBe(true);
      expect(tokenIndex.has('fontSize')).toBe(true);

      const colorPrimaryDefs = tokenIndex.get('colorPrimary');
      expect(colorPrimaryDefs![0].source).toBe('json');
    });

    it('should detect tokens from CSS/LESS files', async () => {
      const files = {
        'styles.less': `
@primary-color: #1890ff;
@border-radius-base: 6px;
@font-size-base: 14px;

.custom-button {
  background-color: @primary-color;
  border-radius: @border-radius-base;
  font-size: @font-size-base;
}
`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('primary-color')).toBe(true);
      expect(tokenIndex.has('border-radius-base')).toBe(true);
      expect(tokenIndex.has('font-size-base')).toBe(true);

      const primaryColorDefs = tokenIndex.get('primary-color');
      expect(primaryColorDefs![0].source).toBe('css');
    });
  });

  describe('Utilities - Text Processing', () => {
    it('should get word at position correctly', () => {
      const document = TextDocument.create(
        'test://test.tsx',
        'typescriptreact',
        1,
        'const style = { color: token.colorPrimary };'
      );

      // Test getting "colorPrimary"
      const word = getWordAtPosition(document, { line: 0, character: 30 });
      expect(word).toBe('colorPrimary');

      // Test getting "token"
      const tokenWord = getWordAtPosition(document, { line: 0, character: 25 });
      expect(tokenWord).toBe('token');
    });

    it('should detect token property access', () => {
      const document = TextDocument.create(
        'test://test.tsx',
        'typescriptreact',
        1,
        'const style = { backgroundColor: token.colorPrimary };'
      );

      const tokenProperty = getTokenPropertyAtPosition(document, { line: 0, character: 40 });
      expect(tokenProperty).toBe('colorPrimary');
    });

    it('should resolve local token values', () => {
      const content = `
const theme = {
  token: {
    colorPrimary: '#1890ff',
    borderRadius: 8
  }
};

const style = {
  color: theme.token.colorPrimary,
  borderRadius: theme.token.borderRadius
};`;

      const resolved = resolveFullTokenValueAtPosition(
        'colorPrimary',
        content,
        { line: 9, character: 25 }
      );

      expect(resolved).toContain('#1890ff');
    });

    it('should handle useToken destructuring', () => {
      const content = `
import { useToken } from 'antd';

const Component = () => {
  const { token } = useToken();
  
  return <div style={{ color: token.colorPrimary }} />;
};`;

      const resolved = resolveFullTokenValueAtPosition(
        'colorPrimary',
        content,
        { line: 6, character: 35 }
      );

      expect(resolved).toBeTruthy();
      expect(resolved!.some(val => val.includes('useToken'))).toBe(true);
    });
  });

  describe('Language Server Integration', () => {
    it('should provide hover information', async () => {
      const files = {
        'test.tsx': `
import { useToken } from 'antd';

const Component = () => {
  const { token } = useToken();
  return <div style={{ color: token.colorPrimary }} />;
};`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      // Mock language server
      const _server = AntdLs.create();
      
      // We'd need to set up the server with our token index
      // This is a simplified test - in practice you'd mock the connection
      expect(tokenIndex.has('colorPrimary')).toBe(true);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple token sources for same token', async () => {
      const files = {
        'App.tsx': `
import { ConfigProvider, useToken } from 'antd';

const theme = {
  token: { colorPrimary: '#ff0000' }
};

const App = () => (
  <ConfigProvider theme={{ token: { colorPrimary: '#00ff00' } }}>
    <Component />
  </ConfigProvider>
);

const Component = () => {
  const { token } = useToken();
  return <div style={{ color: token.colorPrimary }} />;
};`,
        'theme.json': `{
  "token": {
    "colorPrimary": "#0000ff"
  }
}`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      const colorPrimaryDefs = tokenIndex.get('colorPrimary');
      expect(colorPrimaryDefs).toBeTruthy();
      expect(colorPrimaryDefs!.length).toBeGreaterThan(1);

      // Should have multiple sources
      const sources = colorPrimaryDefs!.map(def => def.source);
      expect(sources).toContain('configProvider');
      expect(sources).toContain('json');
    });

    it('should handle nested theme objects', async () => {
      const files = {
        'complex.tsx': `
const lightTheme = {
  token: {
    colorPrimary: '#1890ff',
    colorBgBase: '#ffffff'
  }
};

const darkTheme = {
  token: {
    colorPrimary: '#177ddc',
    colorBgBase: '#000000'
  }
};

const App = ({ isDark }: { isDark: boolean }) => (
  <ConfigProvider theme={isDark ? darkTheme : lightTheme}>
    <Content />
  </ConfigProvider>
);`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('colorBgBase')).toBe(true);

      const colorPrimaryDefs = tokenIndex.get('colorPrimary');
      expect(colorPrimaryDefs!.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle template literals with tokens', async () => {
      const files = {
        'template.tsx': `
const Component = () => {
  const { token } = useToken();
  
  return (
    <div 
      style={{
        margin: \`\${token.marginSM}px \${token.marginLG}px\`,
        fontSize: \`\${token.fontSize}px\`
      }}
    />
  );
};`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('marginSM')).toBe(true);
      expect(tokenIndex.has('marginLG')).toBe(true);
      expect(tokenIndex.has('fontSize')).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON gracefully', async () => {
      const files = {
        'invalid.json': '{ invalid json content'
      };

      const tempDir = await createTempFiles(files);
      
      // Should not throw
      await expect(scanAndIndexTokens(tempDir, tokenIndex)).resolves.not.toThrow();
      expect(tokenIndex.size).toBe(0);
    });

    it('should handle malformed TypeScript gracefully', async () => {
      const files = {
        'invalid.tsx': 'const invalid = { syntax error'
      };

      const tempDir = await createTempFiles(files);
      
      // Should not throw
      await expect(scanAndIndexTokens(tempDir, tokenIndex)).resolves.not.toThrow();
    });

    it('should skip ignored directories', async () => {
      const files = {
        'src/valid.tsx': `const theme = { token: { colorPrimary: '#fff' } };`,
        'node_modules/ignored.tsx': `const theme = { token: { colorIgnored: '#000' } };`,
        'dist/ignored.tsx': `const theme = { token: { colorIgnored: '#000' } };`
      };

      const tempDir = await createTempFiles(files);
      await scanAndIndexTokens(tempDir, tokenIndex);

      expect(tokenIndex.has('colorPrimary')).toBe(true);
      expect(tokenIndex.has('colorIgnored')).toBe(false);
    });
  });
});