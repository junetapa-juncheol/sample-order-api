import { defineConfig } from 'vite';
export default defineConfig({root:'web',base:'/sample-order-api/',build:{outDir:'../docs',emptyOutDir:false,sourcemap:false},esbuild:{legalComments:'none'}});
