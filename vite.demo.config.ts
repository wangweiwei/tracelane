import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 站点构建:把 demo/ 三页打成可托管的静态站(区别于 vite.config.ts 的库模式)。
// base 对应 GitHub Pages 项目站点子路径:https://<user>.github.io/tracelane/
export default defineConfig({
  root: 'demo',
  base: '/tracelane/',
  resolve: {
    alias: { '@': r('./src') }
  },
  build: {
    outDir: r('./dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: r('./demo/index.html'),
        loadmore: r('./demo/loadmore/index.html'),
        bench: r('./demo/bench/index.html')
      }
    }
  }
});
