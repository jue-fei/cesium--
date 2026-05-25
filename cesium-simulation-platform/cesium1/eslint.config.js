import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-plugin-prettier/recommended'

export default [
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  prettier,
  {
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'warn',
      'no-undef': 'off' // TypeScript handles this
    },
    languageOptions: {
      globals: {
        Cesium: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly'
      }
    }
  },
  {
    ignores: ['dist/*', 'public/*', 'coverage/*']
  }
]
