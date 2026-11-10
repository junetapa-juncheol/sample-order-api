import js from '@eslint/js';
import globals from 'globals';
export default [js.configs.recommended, {files:['**/*.js','**/*.mjs'], languageOptions:{globals:{...globals.node,...globals.browser,...globals.jest}}, rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_'}]}}];
