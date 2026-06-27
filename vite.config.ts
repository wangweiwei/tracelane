import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // pnpm dev 时以 demo/ 为站点根目录,展示组件用法
  root: 'demo',
  resolve: {
    // demo 通过 `@/index` 直接引用 src,改库代码即时热更
    alias: { '@': r('./src') }
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    sourcemap: true,
    // 库模式:产出 ESM(.js)+ UMD(.umd.cjs),全局变量名 Tracelane
    lib: {
      entry: r('./src/index.ts'),
      name: 'Tracelane',
      fileName: 'tracelane'
    }
  },
  server: {
    open: true
  }
});
